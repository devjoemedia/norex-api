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
});
