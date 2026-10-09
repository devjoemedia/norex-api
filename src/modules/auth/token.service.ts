import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { keyedHash, randomTokenHex, safeEqualHex } from '../../common/crypto/hash.util';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

interface IssueInput {
  userId: string;
  tenantId: string;
  roles: string[];
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private pepper(): string {
    return this.config.get<string>('JWT_SECRET')!;
  }

  private async signAccess(input: {
    userId: string;
    tenantId: string;
    roles: string[];
    sid: string;
  }) {
    return this.jwt.signAsync({
      sub: input.userId,
      tenantId: input.tenantId,
      roles: input.roles,
      sid: input.sid,
    });
  }

  // New session + token pair. The refresh token is `${sid}.${secret}`; only its
  // keyed hash is stored.
  async issue(input: IssueInput): Promise<TokenPair> {
    const sid = randomUUID();
    const familyId = randomUUID();
    const secret = randomTokenHex();
    const refreshTtl = this.config.get<number>('JWT_REFRESH_TTL', 2592000);

    await this.prisma.session.create({
      data: {
        id: sid,
        tenantId: input.tenantId,
        userId: input.userId,
        familyId,
        refreshHash: keyedHash(this.pepper(), secret),
        ip: input.ip,
        userAgent: input.userAgent,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    return {
      accessToken: await this.signAccess({ ...input, sid }),
      refreshToken: `${sid}.${secret}`,
      tokenType: 'Bearer',
      expiresIn: this.config.get<number>('JWT_ACCESS_TTL', 900),
    };
  }

  // Rotates a refresh token. Reuse of a superseded/revoked secret revokes the family.
  async rotate(
    refreshToken: string,
    tenantId: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<TokenPair> {
    const dot = refreshToken.indexOf('.');
    if (dot < 0) throw new UnauthorizedException('Invalid refresh token');
    const sid = refreshToken.slice(0, dot);
    const secret = refreshToken.slice(dot + 1);

    const session = await this.prisma.session.findFirst({ where: { id: sid, tenantId } });
    if (!session) throw new UnauthorizedException('Invalid refresh token');

    if (session.revokedAt) {
      await this.revokeFamily(session.familyId, tenantId);
      throw new UnauthorizedException('Refresh token no longer valid');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await this.revoke(sid, tenantId);
      throw new UnauthorizedException('Session expired');
    }
    if (!safeEqualHex(keyedHash(this.pepper(), secret), session.refreshHash)) {
      // Old/forged secret against a live session -> token reuse. Kill the family.
      await this.revokeFamily(session.familyId, tenantId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: session.userId, tenantId },
      include: { roles: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    if (user.status === 'suspended') {
      await this.revoke(sid, tenantId);
      throw new ForbiddenException('Account suspended');
    }

    const newSecret = randomTokenHex();
    await this.prisma.session.update({
      where: { id: sid },
      data: {
        refreshHash: keyedHash(this.pepper(), newSecret),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    const roles = user.roles.map((r) => r.role);
    return {
      accessToken: await this.signAccess({ userId: user.id, tenantId, roles, sid }),
      refreshToken: `${sid}.${newSecret}`,
      tokenType: 'Bearer',
      expiresIn: this.config.get<number>('JWT_ACCESS_TTL', 900),
    };
  }

  async revoke(sid: string, tenantId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sid, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string, tenantId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async list(userId: string, tenantId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, tenantId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));
  }

  async revokeOwned(id: string, userId: string, tenantId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, userId, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
