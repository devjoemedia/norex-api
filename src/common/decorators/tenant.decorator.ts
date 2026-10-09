import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';

// Injects the tenant id resolved from the request host (TenantMiddleware).
// Throws if no tenant could be resolved — every tenant-scoped route needs one.
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ tenantId?: string }>();
  if (!req.tenantId) {
    throw new BadRequestException('Unknown or missing tenant (host / X-Tenant)');
  }
  return req.tenantId;
});
