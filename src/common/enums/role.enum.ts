// Platform roles (see docs/01-security-and-multitenancy.md).
export enum Role {
  Customer = 'customer',
  Agent = 'agent',
  ApprovalsOfficer = 'approvals_officer',
  ProductEditor = 'product_editor',
  CountryManager = 'country_manager',
  SuperAdmin = 'super_admin',
  // Delegated HQ admin: reach of a Super Admin, limited to the areas they're granted.
  Admin = 'admin',
}
