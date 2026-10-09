import { ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OtpService } from './otp.service';
import { TokenService, TokenPair } from './token.service';

interface Ctx {
  ip?: string;
  userAgent?: string;
}

export interface AuthResult extends TokenPair {
  user: {
    id: string;
    phone: string | null;
    fullName: string | null;
    email: string | null;
    roles: string[];
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
  ) {}

  async requestOtp(tenantId: string, phone: string, ip?: string): Promise<void> {
    // Always succeeds from the caller's view (no user enumeration); failures are
    // rate-limit/cooldown only.
    await this.otp.request(tenantId, phone, ip);
  }

  async verifyOtp(tenantId: string, phone: string, code: string, ctx: Ctx): Promise<AuthResult> {
    await this.otp.verify(tenantId, phone, code);

    let user = await this.prisma.user.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
      include: { roles: true },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: { tenantId, phone, roles: { create: { tenantId, role: Role.customer } } },
        include: { roles: true },
      });
    }

    if (user.status === 'suspended') throw new ForbiddenException('Account suspended');

    const roles = user.roles.map((r) => r.role);
    const pair = await this.tokens.issue({ userId: user.id, tenantId, roles, ...ctx });

    return {
      ...pair,
      user: { id: user.id, phone: user.phone, fullName: user.fullName, email: user.email, roles },
    };
  }

  async refresh(tenantId: string, refreshToken: string, ctx: Ctx): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken, tenantId, ctx);
  }

  async logout(sid: string, tenantId: string): Promise<void> {
    await this.tokens.revoke(sid, tenantId);
  }
}
