import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { getContext } from '../context/request-context';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

interface JwtPayload {
  sub: string;
  tenantId: string;
  roles?: string[];
  sid?: string;
}

// Verifies the bearer access token and attaches the user; skips @Public() routes.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7), {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      req.user = {
        id: payload.sub,
        tenantId: payload.tenantId,
        roles: payload.roles ?? [],
        sid: payload.sid,
      };
      // The signed-in user (not X-Actor-* hints) is who audit entries record.
      const ctx = getContext();
      if (ctx) {
        ctx.userId = payload.sub;
        ctx.roles = payload.roles ?? [];
      }
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
