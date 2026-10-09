import { rlsScope } from './rls-scope';

describe('rlsScope', () => {
  it('fails closed without a context or tenant', () => {
    expect(rlsScope(undefined)).toBeNull();
    expect(rlsScope({ requestId: 'r' })).toBeNull();
  });

  it('scopes to the request country', () => {
    expect(rlsScope({ requestId: 'r', tenantId: 'gm' })).toEqual({
      tenantId: 'gm',
      allTenants: false,
      system: false,
    });
  });

  it('all-countries mode reads every tenant but names none', () => {
    expect(rlsScope({ requestId: 'r', allTenants: true })).toEqual({
      tenantId: '',
      allTenants: true,
      system: false,
    });
  });

  it('a per-country scope inside all mode wins (withTenant)', () => {
    expect(rlsScope({ requestId: 'r', allTenants: true, tenantId: 'lr' })?.tenantId).toBe('lr');
  });

  it('system scope wins over everything', () => {
    expect(rlsScope({ requestId: 'r', tenantId: 'gm', system: true })).toEqual({
      tenantId: '',
      allTenants: false,
      system: true,
    });
  });
});
