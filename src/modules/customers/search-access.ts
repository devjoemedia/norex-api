import { AdminPermissions } from '../../common/auth/admin-permissions';

// What each signed-in staff member may find through global search. Mirrors the page
// access in the portal, so a result never leads somewhere the person can't open.
export type SearchKind = 'application' | 'order' | 'customer' | 'device' | 'staff';

const BY_ROLE: Record<string, SearchKind[]> = {
  super_admin: ['application', 'order', 'customer', 'device', 'staff'],
  country_manager: ['application', 'order', 'customer', 'device', 'staff'],
  approvals_officer: ['application', 'customer', 'device'],
  product_editor: ['order', 'device'],
  agent: ['application', 'order', 'customer', 'device'],
  support: ['application', 'order', 'customer'],
};

const BY_ADMIN_AREA: Partial<Record<keyof AdminPermissions, SearchKind[]>> = {
  applications: ['application', 'customer'],
  orders: ['order'],
  devices: ['device'],
  staff: ['staff'],
};

export function searchKindsFor(
  roles: string[],
  permissions?: AdminPermissions | null,
): Set<SearchKind> {
  const kinds = new Set<SearchKind>();
  for (const role of roles) for (const k of BY_ROLE[role] ?? []) kinds.add(k);
  if (roles.includes('admin')) {
    for (const [area, level] of Object.entries(permissions ?? {})) {
      if (level) for (const k of BY_ADMIN_AREA[area as keyof AdminPermissions] ?? []) kinds.add(k);
    }
  }
  return kinds;
}
