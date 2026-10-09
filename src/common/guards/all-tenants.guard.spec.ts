import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AllTenantsGuard } from './all-tenants.guard';

function ctx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('AllTenantsGuard', () => {
  const guard = (allowed: boolean) =>
    new AllTenantsGuard({ getAllAndOverride: () => allowed } as unknown as Reflector);
  const superAdmin = { roles: ['super_admin'] };
  const manager = { roles: ['country_manager'] };

  it('ignores single-country requests', () => {
    expect(guard(false).canActivate(ctx({ method: 'POST', user: manager }))).toBe(true);
  });

  it('lets a super admin read all countries on a marked GET', () => {
    expect(
      guard(true).canActivate(ctx({ allTenants: true, method: 'GET', user: superAdmin })),
    ).toBe(true);
  });

  it('refuses writes in all-countries mode', () => {
    expect(() =>
      guard(true).canActivate(ctx({ allTenants: true, method: 'POST', user: superAdmin })),
    ).toThrow(BadRequestException);
  });

  it('refuses routes that did not opt in', () => {
    expect(() =>
      guard(false).canActivate(ctx({ allTenants: true, method: 'GET', user: superAdmin })),
    ).toThrow(BadRequestException);
  });

  it('refuses a country manager', () => {
    expect(() =>
      guard(true).canActivate(ctx({ allTenants: true, method: 'GET', user: manager })),
    ).toThrow(ForbiddenException);
  });
});
