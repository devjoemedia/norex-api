import { normalizeHost, resolveTenant, TenantLookup } from './resolve-tenant';

const lookup: TenantLookup = {
  byHost: async (h) => ({ 'norexguinea.com': 't-guinea' })[h],
  bySubdomain: async (s) =>
    ({ gambia: 't-gambia', guinea: 't-guinea', liberia: 't-liberia', hq: 't-hq' })[s],
};

describe('resolveTenant (docs/15 order)', () => {
  it('matches a full country domain first (incl. www and port)', async () => {
    expect((await resolveTenant('www.norexguinea.com:443', undefined, lookup)).tenantId).toBe(
      't-guinea',
    );
  });
  it('falls back to the subdomain', async () => {
    expect((await resolveTenant('gambia.norex.com', 'liberia', lookup)).tenantId).toBe('t-gambia');
  });
  it('supports country.localhost in local development', async () => {
    expect((await resolveTenant('gambia.localhost:3000', undefined, lookup)).tenantId).toBe(
      't-gambia',
    );
  });
  it('uses X-Tenant when the host is not a tenant (api host, localhost)', async () => {
    expect((await resolveTenant('api.norex.com', 'liberia', lookup)).tenantId).toBe('t-liberia');
    expect((await resolveTenant('localhost:3001', 'guinea', lookup)).tenantId).toBe('t-guinea');
  });
  it('flags "all" without resolving a tenant', async () => {
    const r = await resolveTenant('localhost', 'ALL', lookup);
    expect(r).toEqual({ allTenants: true, subdomain: 'all' });
  });
  it('leaves an unknown tenant unresolved', async () => {
    expect((await resolveTenant('localhost', 'nigeria', lookup)).tenantId).toBeUndefined();
  });
  it('normalizes hosts', () => {
    expect(normalizeHost('WWW.NorexLiberia.com:8080')).toBe('norexliberia.com');
  });
});

describe('resolveTenant: unlaunched countries', () => {
  const lookup = {
    byHost: async () => undefined,
    bySubdomain: async (s: string) => (s === 'gambia' ? 'gm' : undefined),
    byHeader: async (s: string) => ({ gambia: 'gm', senegal: 'sn' })[s],
  };

  it('staff reach an unlaunched country via X-Tenant', async () => {
    expect((await resolveTenant('localhost', 'senegal', lookup)).tenantId).toBe('sn');
  });

  it('the public website (subdomain) does not', async () => {
    expect((await resolveTenant('senegal.norex.com', undefined, lookup)).tenantId).toBeUndefined();
  });
});
