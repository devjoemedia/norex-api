import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../enums/role.enum';
import { RolesGuard } from './roles.guard';

const ctx = (roles: string[]) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

const guard = (required: Role[]) =>
  new RolesGuard({ getAllAndOverride: () => required } as unknown as Reflector);

describe('RolesGuard', () => {
  it('lets a Super Admin into any staff route', () => {
    expect(guard([Role.CountryManager]).canActivate(ctx(['super_admin']))).toBe(true);
    expect(guard([Role.Agent]).canActivate(ctx(['super_admin']))).toBe(true);
  });

  it('keeps customer-only routes for customers', () => {
    expect(() => guard([Role.Customer]).canActivate(ctx(['super_admin']))).toThrow(
      ForbiddenException,
    );
  });

  it('still checks everyone else', () => {
    expect(() => guard([Role.CountryManager]).canActivate(ctx(['agent']))).toThrow(
      ForbiddenException,
    );
    expect(guard([Role.CountryManager]).canActivate(ctx(['country_manager']))).toBe(true);
  });

  it('lets a delegated admin in by area and level', () => {
    const adminCtx = (method: string, path: string, permissions: Record<string, string>) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ method, route: { path }, user: { roles: ['admin'], permissions } }),
        }),
        getHandler: () => undefined,
        getClass: () => undefined,
      }) as unknown as ExecutionContext;
    const g = guard([Role.CountryManager, Role.SuperAdmin]);
    expect(g.canActivate(adminCtx('GET', '/api/admin/orders', { orders: 'view' }))).toBe(true);
    expect(() =>
      g.canActivate(adminCtx('POST', '/api/admin/orders/:id/action', { orders: 'view' })),
    ).toThrow(ForbiddenException);
    expect(() =>
      g.canActivate(adminCtx('GET', '/api/admin/countries', { staff: 'manage' })),
    ).toThrow(ForbiddenException);
    expect(() => guard([Role.Customer]).canActivate(adminCtx('GET', '/api/me', {}))).toThrow(
      ForbiddenException,
    );
  });
});
