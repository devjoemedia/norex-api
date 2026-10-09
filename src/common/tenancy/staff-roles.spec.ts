import { ForbiddenException } from '@nestjs/common';
import { assertCanGrant, canGrant } from './staff-roles';

describe('staff role grants', () => {
  it('a super admin can grant any role', () => {
    for (const r of ['agent', 'country_manager', 'super_admin'])
      expect(canGrant(['super_admin'], r)).toBe(true);
  });

  it('a country manager can grant country staff roles only', () => {
    const cm = ['country_manager'];
    expect(canGrant(cm, 'agent')).toBe(true);
    expect(canGrant(cm, 'approvals_officer')).toBe(true);
    expect(canGrant(cm, 'product_editor')).toBe(true);
    expect(canGrant(cm, 'country_manager')).toBe(false);
    expect(canGrant(cm, 'super_admin')).toBe(false);
  });

  it('other staff cannot grant roles', () => {
    expect(canGrant(['agent'], 'agent')).toBe(false);
  });

  it('assertCanGrant throws on the first blocked role', () => {
    expect(() => assertCanGrant(['country_manager'], ['agent', 'country_manager'])).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanGrant(['country_manager'], ['agent'])).not.toThrow();
  });
});
