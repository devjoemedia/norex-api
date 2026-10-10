import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role } from '../enums/role.enum';
import { AdminPermissions, adminCanAccess } from '../auth/admin-permissions';

// Enforces @Roles(...) on handlers. Routes without @Roles pass (auth still required
// unless @Public). Resource-level ownership checks live in the services.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const roles: string[] = req.user?.roles ?? [];
    // A Super Admin manages every country (docs/15), so any staff route is open to
    // them; customer-only routes are not (they act as "the customer").
    if (roles.includes(Role.SuperAdmin) && required.some((r) => r !== Role.Customer)) {
      return true;
    }
    // A delegated admin has a Super Admin's reach, but only in the areas granted to
    // them (route -> area in admin-permissions.ts). Unmapped routes stay closed.
    if (roles.includes(Role.Admin) && required.some((r) => r !== Role.Customer)) {
      const path: string = req.route?.path ?? req.path;
      const perms = req.user?.permissions as AdminPermissions | undefined;
      if (adminCanAccess(perms, req.method, path)) return true;
      throw new ForbiddenException("Your admin access doesn't include this");
    }
    if (!required.some((r) => roles.includes(r))) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
