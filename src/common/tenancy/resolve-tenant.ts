// Pure tenant-resolution order (docs/15): full-domain match, then subdomain, then the
// X-Tenant header; `all` is only a request flag — AllTenantsGuard decides if it's allowed.
// Domains and subdomains (the public websites) only reach launched countries; the
// header also reaches unlaunched ones so staff can prepare them.
export const ALL_TENANTS_HEADER = 'all';

export interface TenantLookup {
  byHost(host: string): Promise<string | undefined>; // tenant_domains
  bySubdomain(sub: string): Promise<string | undefined>; // active tenants
  /** X-Tenant (portal/staff): also finds countries not launched yet. */
  byHeader?(slug: string): Promise<string | undefined>;
}

export interface ResolvedTenant {
  tenantId?: string;
  subdomain?: string;
  allTenants: boolean;
}

export function normalizeHost(raw: string | undefined): string {
  return String(raw ?? '')
    .split(',')[0]
    .trim()
    .split(':')[0]
    .toLowerCase()
    .replace(/^www\./, '');
}

export async function resolveTenant(
  rawHost: string | undefined,
  headerTenant: string | undefined,
  lookup: TenantLookup,
): Promise<ResolvedTenant> {
  const host = normalizeHost(rawHost);
  const header = headerTenant?.trim().toLowerCase() || undefined;

  if (host && host !== 'localhost') {
    const byDomain = await lookup.byHost(host);
    if (byDomain) return { tenantId: byDomain, subdomain: host, allTenants: false };
    const labels = host.split('.');
    // country.norex.com, or country.localhost in local development
    if (labels.length >= 3 || (labels.length === 2 && labels[1] === 'localhost')) {
      const bySub = await lookup.bySubdomain(labels[0]);
      if (bySub) return { tenantId: bySub, subdomain: labels[0], allTenants: false };
    }
  }
  if (header === ALL_TENANTS_HEADER) return { allTenants: true, subdomain: header };
  if (header) {
    const byHeader = await (lookup.byHeader ?? lookup.bySubdomain)(header);
    return { tenantId: byHeader, subdomain: header, allTenants: false };
  }
  return { allTenants: false };
}
