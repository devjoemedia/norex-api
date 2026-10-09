import { SetMetadata } from '@nestjs/common';

// Marks a read-only admin/report route that a Super Admin may call with
// `X-Tenant: all` (every country at once). See AllTenantsGuard + docs/15.
export const ALLOW_ALL_TENANTS_KEY = 'allowAllTenants';
export const AllowAllTenants = () => SetMetadata(ALLOW_ALL_TENANTS_KEY, true);
