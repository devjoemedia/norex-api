import { adminCanAccess, areaForPath, normalizePermissions } from './admin-permissions';

describe('admin permissions', () => {
  it('maps routes to areas, specific prefixes first', () => {
    expect(areaForPath('/api/admin/orders/abc/handover')).toBe('orders');
    expect(areaForPath('/api/admin/trade-in/condition-options')).toBe('applications');
    expect(areaForPath('/api/admin/all-users/:id')).toBe('staff');
    expect(areaForPath('/api/finance/plans/:planId/rules')).toBe('catalog');
    expect(areaForPath('/api/admin/countries')).toBeNull();
    // A prefix must match a whole segment.
    expect(areaForPath('/api/admin/ordersx')).toBeNull();
  });

  it('view opens reads only; manage opens writes', () => {
    const perms = { orders: 'view', catalog: 'manage' } as const;
    expect(adminCanAccess(perms, 'GET', '/api/admin/orders')).toBe(true);
    expect(adminCanAccess(perms, 'POST', '/api/admin/orders/:id/action')).toBe(false);
    expect(adminCanAccess(perms, 'PATCH', '/api/admin/catalog/devices/:id')).toBe(true);
    expect(adminCanAccess(perms, 'GET', '/api/admin/payments')).toBe(false);
  });

  it('keeps Super Admin areas closed and the dashboard open', () => {
    expect(adminCanAccess({ staff: 'manage' }, 'GET', '/api/admin/countries')).toBe(false);
    expect(adminCanAccess({}, 'GET', '/api/admin/dashboard')).toBe(true);
    expect(adminCanAccess(null, 'GET', '/api/admin/orders')).toBe(false);
  });

  it('drops unknown areas and levels', () => {
    expect(
      normalizePermissions({ orders: 'manage', catalog: 'admin', countries: 'manage', x: 1 }),
    ).toEqual({ orders: 'manage' });
    expect(normalizePermissions(['orders'])).toEqual({});
    expect(normalizePermissions(null)).toEqual({});
  });
});
