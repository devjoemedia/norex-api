// Delegated admins (role `admin`): HQ staff a Super Admin creates to run parts of
// the business on their behalf. Each one gets a level per area instead of a fixed
// role. "view" opens the area's read routes (GET/HEAD); "manage" also opens its
// writes. Routes outside every area (countries, roles) stay Super Admin only.
// Mirrored in the portal at src/constants/admin-permissions.ts.

export const ADMIN_AREAS = [
  'applications',
  'orders',
  'catalog',
  'devices',
  'outlets',
  'payments',
  'reports',
  'staff',
  'content',
  'audit',
] as const;

export type AdminArea = (typeof ADMIN_AREAS)[number];
export type AdminLevel = 'view' | 'manage';
export type AdminPermissions = Partial<Record<AdminArea, AdminLevel>>;

// Route prefixes (after /api) per area. The first match wins, so the more specific
// /admin/... prefixes are listed before the bare ones they would otherwise shadow.
const AREA_ROUTES: Array<[string, AdminArea]> = [
  ['/admin/applications', 'applications'],
  ['/admin/customers', 'applications'],
  ['/admin/kyc', 'applications'],
  ['/admin/trade-in', 'applications'],
  ['/applications', 'applications'],
  ['/kyc/profiles', 'applications'],
  ['/trade-in', 'applications'],
  ['/leases', 'applications'],

  ['/admin/orders', 'orders'],
  ['/admin/pickups', 'orders'],
  ['/fulfilment', 'orders'],

  ['/admin/catalog', 'catalog'],
  ['/admin/inventory', 'catalog'],
  ['/admin/lease', 'catalog'],
  ['/finance/plans', 'catalog'],

  ['/admin/device-units', 'devices'],

  ['/admin/branches', 'outlets'],
  ['/admin/branch-management', 'outlets'],
  ['/admin/branch-admins', 'outlets'],
  ['/admin/agents', 'outlets'],

  ['/admin/payments', 'payments'],
  ['/admin/payment-providers', 'payments'],
  ['/admin/collections', 'payments'],
  ['/admin/reconciliation', 'payments'],
  ['/admin/arrears', 'payments'],
  ['/payments', 'payments'],
  ['/schedules', 'payments'],

  ['/admin/analytics', 'reports'],
  ['/admin/reports', 'reports'],
  ['/reports', 'reports'],

  ['/admin/all-users', 'staff'],
  ['/admin/users', 'staff'],
  ['/admin/staff', 'staff'],

  ['/admin/content', 'content'],
  ['/admin/notifications', 'content'],

  ['/admin/activity-log', 'audit'],
];

// Open to every admin: the dashboard is their landing page and shows only totals.
const ALWAYS_OPEN = ['/admin/dashboard'];

function stripApi(path: string): string {
  const p = path.split('?')[0].replace(/\/+$/, '');
  return p.startsWith('/api/') || p === '/api' ? p.slice(4) || '/' : p;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The area a route belongs to, or null when no admin area covers it. */
export function areaForPath(path: string): AdminArea | null {
  const p = stripApi(path);
  return AREA_ROUTES.find(([prefix]) => under(p, prefix))?.[1] ?? null;
}

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Whether a delegated admin with `perms` may call `method path`. */
export function adminCanAccess(
  perms: AdminPermissions | null | undefined,
  method: string,
  path: string,
): boolean {
  const p = stripApi(path);
  if (ALWAYS_OPEN.some((prefix) => under(p, prefix))) return true;
  const area = areaForPath(p);
  if (!area) return false;
  const level = perms?.[area];
  if (level === 'manage') return true;
  return level === 'view' && READ_METHODS.has(method.toUpperCase());
}

/**
 * Cleans untrusted input (request bodies, the JSON column) into a permission map:
 * unknown areas and levels are dropped, so nothing outside ADMIN_AREAS is granted.
 */
export function normalizePermissions(input: unknown): AdminPermissions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: AdminPermissions = {};
  for (const area of ADMIN_AREAS) {
    const level = (input as Record<string, unknown>)[area];
    if (level === 'view' || level === 'manage') out[area] = level;
  }
  return out;
}
