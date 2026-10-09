import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_ALL_TENANTS_KEY } from '../decorators/all-tenants.decorator';
import { Role } from '../enums/role.enum';

// `X-Tenant: all` (every country) is read-only and Super Admin only (docs/15): the
// route must opt in with @AllowAllTenants and be a GET. Anything else is refused.
@Injectable()
export class AllTenantsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.allTenants) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_ALL_TENANTS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!allowed || req.method !== 'GET') {
      throw new BadRequestException(
        'Pick one country for this action (X-Tenant: all is read-only)',
      );
    }
    if (!req.user?.roles?.includes(Role.SuperAdmin)) {
      throw new ForbiddenException('Only a super admin can view all countries');
    }
    return true;
  }
}
