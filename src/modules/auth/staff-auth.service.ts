import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { Prisma } from '@prisma/client';
import { AdminPermissions, normalizePermissions } from '../../common/auth/admin-permissions';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { keyedHash, randomTokenHex } from '../../common/crypto/hash.util';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';
import { TokenPair, TokenService } from './token.service';
import { StaffInviteService } from './staff-invite.service';
import { assertStaffPassword } from '../../common/auth/staff-password';

authenticator.options = { window: 1 }; // tolerate ~30s clock drift

const CHALLENGE_TTL_SECONDS = 600;
const MAX_2FA_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 8;

interface Ctx {
  ip?: string;
  userAgent?: string;
}

type LoginChallenge =
  | ({ status: 'signed_in' } & StaffAuthResult)
  | { status: 'set_password'; challengeId: string }
  | { status: 'enroll_2fa'; challengeId: string; secret: string; otpauthUrl: string }
  | { status: '2fa_required'; challengeId: string };

type StaffUser = { id: string; email: string | null; totpEnabledAt: Date | null };

export interface StaffAuthResult extends TokenPair {
  user: {
    id: string;
    email: string | null;
    fullName: string | null;
    roles: string[];
    permissions?: AdminPermissions;
  };
  recoveryCodes?: string[];
}

@Injectable()
export class StaffAuthService {
  private dummyHash?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly invites: StaffInviteService,
  ) {}

  private encKey(): string {
    return this.config.get<string>('ENCRYPTION_KEY') ?? this.config.get<string>('JWT_SECRET')!;
  }
  private pepper(): string {
    return this.config.get<string>('JWT_SECRET')!;
  }
  // Constant-ish work even for unknown accounts (no enumeration / timing signal).
  private async dummy(): Promise<string> {
    return (this.dummyHash ??= await argon2.hash(randomTokenHex()));
  }

  /** STAFF_2FA_ENABLED: when off, the password alone signs staff in. */
  twoFactorEnabled(): boolean {
    return this.config.get<boolean>('STAFF_2FA_ENABLED') === true;
  }

  async login(
    tenantId: string,
    email: string,
    password: string,
    ctx: Ctx = {},
  ): Promise<LoginChallenge> {
    const user = await this.prisma.user.findFirst({ where: { tenantId, email } });
    const hash = user?.passwordHash ?? (await this.dummy());
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !user.isStaff || !user.passwordHash || !ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.status === 'suspended') throw new ForbiddenException('Account suspended');

    // A password someone else chose (an old one-time password, or one set by an
    // admin or a script) is replaced by the staff member's own before anything else.
    if (!user.passwordSetAt) {
      const challenge = await this.prisma.staffChallenge.create({
        data: { tenantId, userId: user.id, purpose: 'set_password', expiresAt: this.expiry() },
      });
      return { status: 'set_password', challengeId: challenge.id };
    }
    return this.secondFactor(tenantId, user, ctx);
  }

  private expiry(): Date {
    return new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
  }

  // After the password: set up two-factor the first time, otherwise ask for a code.
  // With two-factor switched off, the password was enough: sign in now.
  private async secondFactor(tenantId: string, user: StaffUser, ctx: Ctx): Promise<LoginChallenge> {
    if (!this.twoFactorEnabled()) {
      return { status: 'signed_in', ...(await this.signIn(tenantId, user.id, ctx)) };
    }
    const expiresAt = this.expiry();
    const email = user.email ?? '';

    if (!user.totpEnabledAt) {
      const secret = authenticator.generateSecret();
      const challenge = await this.prisma.staffChallenge.create({
        data: {
          tenantId,
          userId: user.id,
          purpose: 'enroll_2fa',
          enrollSecret: encryptSecret(secret, this.encKey()),
          expiresAt,
        },
      });
      return {
        status: 'enroll_2fa',
        challengeId: challenge.id,
        secret,
        otpauthUrl: authenticator.keyuri(email, 'Norex', secret),
      };
    }

    const challenge = await this.prisma.staffChallenge.create({
      data: { tenantId, userId: user.id, purpose: 'login_2fa', expiresAt },
    });
    return { status: '2fa_required', challengeId: challenge.id };
  }

  async verify2fa(
    tenantId: string,
    challengeId: string,
    input: { totp?: string; recoveryCode?: string },
    ctx: Ctx,
  ): Promise<StaffAuthResult> {
    if (!input.totp && !input.recoveryCode) {
      throw new BadRequestException('Provide a TOTP code or a recovery code');
    }

    const challenge = await this.prisma.staffChallenge.findFirst({
      where: {
        id: challengeId,
        tenantId,
        purpose: { in: ['login_2fa', 'enroll_2fa'] },
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!challenge) throw new UnauthorizedException('Invalid or expired challenge');
    if (challenge.attempts >= MAX_2FA_ATTEMPTS) {
      await this.consume(challenge.id);
      throw new UnauthorizedException('Too many attempts — start again');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: challenge.userId, tenantId },
      include: { roles: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    if (user.status === 'suspended') throw new ForbiddenException('Account suspended');

    let recoveryCodes: string[] | undefined;

    if (challenge.purpose === 'enroll_2fa') {
      if (!input.totp)
        throw new BadRequestException('A TOTP code is required to finish enrollment');
      const secret = decryptSecret(challenge.enrollSecret!, this.encKey());
      if (!authenticator.verify({ token: input.totp, secret })) {
        await this.bumpAttempts(challenge.id);
        throw new UnauthorizedException('Invalid code');
      }
      recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomTokenHex(5));
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { totpSecret: encryptSecret(secret, this.encKey()), totpEnabledAt: new Date() },
        }),
        this.prisma.recoveryCode.createMany({
          data: recoveryCodes.map((c) => ({
            tenantId,
            userId: user.id,
            codeHash: keyedHash(this.pepper(), c),
          })),
        }),
        this.prisma.staffChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        }),
      ]);
      await this.audit.write(tenantId, {
        actorId: user.id,
        actorRole: user.roles.map((r) => r.role).join(','),
        action: 'staff.totp_enrolled',
        entity: 'user',
        entityId: user.id,
        ip: ctx.ip,
      });
    } else {
      const passed = input.totp
        ? authenticator.verify({
            token: input.totp,
            secret: decryptSecret(user.totpSecret!, this.encKey()),
          })
        : await this.consumeRecoveryCode(tenantId, user.id, input.recoveryCode!);
      if (!passed) {
        await this.bumpAttempts(challenge.id);
        throw new UnauthorizedException('Invalid code');
      }
      await this.consume(challenge.id);
      await this.audit.write(tenantId, {
        actorId: user.id,
        actorRole: user.roles.map((r) => r.role).join(','),
        action: 'staff.login',
        entity: 'user',
        entityId: user.id,
        ip: ctx.ip,
      });
    }

    return { ...(await this.session(tenantId, user, ctx)), recoveryCodes };
  }

  // Password-only sign-in (two-factor off): audited like a two-factor sign-in.
  private async signIn(tenantId: string, userId: string, ctx: Ctx): Promise<StaffAuthResult> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      include: { roles: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    if (user.status === 'suspended') throw new ForbiddenException('Account suspended');
    await this.audit.write(tenantId, {
      actorId: user.id,
      actorRole: user.roles.map((r) => r.role).join(','),
      action: 'staff.login',
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
    });
    return this.session(tenantId, user, ctx);
  }

  private async session(
    tenantId: string,
    user: {
      id: string;
      email: string | null;
      fullName: string | null;
      permissions: Prisma.JsonValue;
      roles: { role: string }[];
    },
    ctx: Ctx,
  ): Promise<StaffAuthResult> {
    const roles = user.roles.map((r) => r.role);
    const pair = await this.tokens.issue({
      userId: user.id,
      tenantId,
      roles,
      permissions: user.permissions,
      ...ctx,
    });
    const permissions = roles.includes('admin')
      ? normalizePermissions(user.permissions)
      : undefined;
    return {
      ...pair,
      user: { id: user.id, email: user.email, fullName: user.fullName, roles, permissions },
    };
  }

  // Step after sign-in with a password someone else chose: the staff member picks
  // their own, then continues to two-factor.
  async setPassword(
    tenantId: string,
    challengeId: string,
    password: string,
    ctx: Ctx,
  ): Promise<LoginChallenge> {
    const challenge = await this.prisma.staffChallenge.findFirst({
      where: {
        id: challengeId,
        tenantId,
        purpose: 'set_password',
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });
    if (!challenge) throw new UnauthorizedException('This step expired. Sign in again.');
    const user = challenge.user;
    if (user.status === 'suspended') throw new ForbiddenException('Account suspended');
    assertStaffPassword(password, user.email);
    if (
      user.passwordHash &&
      (await argon2.verify(user.passwordHash, password).catch(() => false))
    ) {
      throw new BadRequestException('Choose a new password, not the one you were given');
    }
    await this.storePassword(user.id, password);
    await this.consume(challenge.id);
    await this.audit.write(tenantId, {
      actorId: user.id,
      action: 'staff.password_set',
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
    });
    return this.secondFactor(tenantId, user, ctx);
  }

  /** What the accept-invite page shows before the person chooses a password. */
  async inspectInvite(tenantId: string, token: string) {
    const invite = await this.invites.find(tenantId, token);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    return {
      email: invite.user.email,
      fullName: invite.user.fullName,
      signInTo: tenant?.isCountry ? tenant.name : 'Norex HQ',
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  // Invite link -> own password -> two-factor setup, or signed in when it's off.
  async acceptInvite(
    tenantId: string,
    token: string,
    password: string,
    ctx: Ctx,
  ): Promise<LoginChallenge> {
    const invite = await this.invites.find(tenantId, token);
    const user = invite.user;
    assertStaffPassword(password, user.email);
    await this.storePassword(user.id, password);
    await this.consume(invite.id);
    await this.audit.write(tenantId, {
      actorId: user.id,
      action: 'staff.invite_accepted',
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
    });
    return this.secondFactor(tenantId, { ...user, totpEnabledAt: null }, ctx);
  }

  // Signed-in change. Other sessions are signed out; this one stays.
  async changePassword(
    actor: { id: string; tenantId: string; sid?: string },
    currentPassword: string,
    newPassword: string,
    ctx: Ctx,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: actor.id, tenantId: actor.tenantId, isStaff: true },
    });
    if (!user?.passwordHash) throw new BadRequestException('This account has no password');
    if (!(await argon2.verify(user.passwordHash, currentPassword).catch(() => false))) {
      throw new BadRequestException('Your current password is not right');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('Choose a password you are not using now');
    }
    assertStaffPassword(newPassword, user.email);
    await this.storePassword(user.id, newPassword);
    await this.prisma.session.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(actor.sid ? { id: { not: actor.sid } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    await this.audit.write(actor.tenantId, {
      actorId: user.id,
      action: 'staff.password_changed',
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
    });
  }

  private async storePassword(userId: string, password: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        passwordSetAt: new Date(),
      },
    });
  }

  private consume(id: string) {
    return this.prisma.staffChallenge.update({ where: { id }, data: { consumedAt: new Date() } });
  }
  private bumpAttempts(id: string) {
    return this.prisma.staffChallenge.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }
  private async consumeRecoveryCode(
    tenantId: string,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const rc = await this.prisma.recoveryCode.findFirst({
      where: { tenantId, userId, usedAt: null, codeHash: keyedHash(this.pepper(), code) },
    });
    if (!rc) return false;
    await this.prisma.recoveryCode.update({ where: { id: rc.id }, data: { usedAt: new Date() } });
    return true;
  }
}
