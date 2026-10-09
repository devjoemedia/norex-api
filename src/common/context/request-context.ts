import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context, available anywhere without prop-drilling. Populated by
// TenantMiddleware (tenant) and JwtAuthGuard (user); read by the RLS scope in
// PrismaService, so every query is limited to this request's country.
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  tenantSubdomain?: string;
  /** Super Admin `X-Tenant: all` read (AllTenantsGuard checked it). */
  allTenants?: boolean;
  /** Trusted cross-country work (catalog clone, scripts): RLS allows every tenant. */
  system?: boolean;
  /** Set while a batch $transaction runs, so its queries share one scope. */
  inTransaction?: boolean;
  userId?: string;
  roles?: string[];
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}

function runWith<T>(patch: Partial<RequestContext>, fn: () => T): T {
  const current = getContext() ?? { requestId: 'internal' };
  return requestContext.run({ ...current, ...patch }, fn);
}

/** Runs `fn` with the database limited to one country (e.g. per country in "all" mode). */
export function withTenant<T>(tenantId: string, fn: () => T): T {
  return runWith({ tenantId, allTenants: false, system: false }, fn);
}

/** Runs `fn` with RLS open to every country. Only for trusted, audited operations. */
export function asSystem<T>(fn: () => T): T {
  return runWith({ system: true }, fn);
}
