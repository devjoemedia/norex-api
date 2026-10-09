import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role } from '../enums/role.enum';

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
    if (!required.some((r) => roles.includes(r))) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
