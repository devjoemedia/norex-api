import type { RequestContext } from '../common/context/request-context';

// What prisma/rls.sql should allow for the current request. `null` = no scope:
// every tenant row is hidden and writes are refused (fails closed).
export interface RlsScope {
  tenantId: string;
  allTenants: boolean;
  system: boolean;
}

export function rlsScope(ctx: RequestContext | undefined): RlsScope | null {
  if (!ctx) return null;
  if (ctx.system) return { tenantId: '', allTenants: false, system: true };
  if (ctx.tenantId) return { tenantId: ctx.tenantId, allTenants: false, system: false };
  if (ctx.allTenants) return { tenantId: '', allTenants: true, system: false };
  return null;
}

// Transaction-local settings the policies read. Parameterised, so no injection.
export function scopeStatement<T>(
  exec: (strings: TemplateStringsArray, ...values: unknown[]) => T,
  scope: RlsScope,
): T {
  return exec`SELECT set_config('app.tenant_id', ${scope.tenantId}, true),
                     set_config('app.all_tenants', ${scope.allTenants ? 'on' : 'off'}, true),
                     set_config('app.system', ${scope.system ? 'on' : 'off'}, true)`;
}
