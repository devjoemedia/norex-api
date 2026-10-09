import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';

// Either one country's tenant id, or ALL_TENANTS when a Super Admin asked for every
// country (only reachable on @AllowAllTenants routes — AllTenantsGuard enforces it).
export const ALL_TENANTS = Symbol('all-tenants');
export type TenantScopeValue = string | typeof ALL_TENANTS;

export const TenantScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantScopeValue => {
    const req = ctx.switchToHttp().getRequest<{ tenantId?: string; allTenants?: boolean }>();
    if (req.allTenants) return ALL_TENANTS;
    if (!req.tenantId) throw new BadRequestException('Unknown or missing tenant (host / X-Tenant)');
    return req.tenantId;
  },
);
