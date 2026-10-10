import { ForbiddenException } from '@nestjs/common';

// Roles a Country Manager may hand out inside their own country (docs/15). Only a
// Super Admin creates Country Managers, delegated admins or other Super Admins; a
// delegated admin with "staff: manage" hands out the same roles as a Country Manager.
export const COUNTRY_MANAGER_GRANTABLE = [
  'customer',
  'agent',
  'approvals_officer',
  'product_editor',
  'support',
];

export function canGrant(actorRoles: readonly string[], role: string): boolean {
  if (actorRoles.includes('super_admin')) return true;
  if (actorRoles.includes('country_manager') || actorRoles.includes('admin')) {
    return COUNTRY_MANAGER_GRANTABLE.includes(role);
  }
  return false;
}

export function assertCanGrant(actorRoles: readonly string[], roles: readonly string[]): void {
  const blocked = roles.find((r) => !canGrant(actorRoles, r));
  if (blocked) throw new ForbiddenException(`You can't grant the ${blocked} role`);
}
