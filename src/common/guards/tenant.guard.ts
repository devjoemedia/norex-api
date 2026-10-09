import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from '../enums/role.enum';

// Asserts the authenticated user's tenant matches the tenant resolved from the
// request host — so a token from one country can never be used on another.
// super_admin may operate cross-tenant (audited elsewhere).
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) return true; // public route or unauthenticated (handled by JwtAuthGuard)

    if (user.roles?.includes(Role.SuperAdmin)) return true;

    const resolved = req.tenantId as string | undefined;
    if (resolved && user.tenantId && resolved !== user.tenantId) {
      throw new ForbiddenException('Tenant mismatch');
    }
    return true;
  }
}
