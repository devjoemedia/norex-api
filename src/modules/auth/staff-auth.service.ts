import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { AdminPermissions, normalizePermissions } from '../../common/auth/admin-permissions';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { keyedHash, randomTokenHex } from '../../common/crypto/hash.util';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';
import { TokenPair, TokenService } from './token.service';

authenticator.options = { window: 1 }; // tolerate ~30s clock drift

const CHALLENGE_TTL_SECONDS = 600;
const MAX_2FA_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 8;

interface Ctx {
  ip?: string;
  userAgent?: string;
}

type LoginChallenge =
  | { status: 'enroll_2fa'; challengeId: string; secret: string; otpauthUrl: string }
  | { status: '2fa_required'; challengeId: string };

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

  async login(tenantId: string, email: string, password: string): Promise<LoginChallenge> {
    const user = await this.prisma.user.findFirst({ where: { tenantId, email } });
    const hash = user?.passwordHash ?? (await this.dummy());
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !user.isStaff || !user.passwordHash || !ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.status === 'suspended') throw new ForbiddenException('Account suspended');

    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);

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
      where: { id: challengeId, tenantId, consumedAt: null, expiresAt: { gt: new Date() } },
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
      recoveryCodes,
    };
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
