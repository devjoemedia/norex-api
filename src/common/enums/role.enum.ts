// Platform roles (see docs/01-security-and-multitenancy.md).
export enum Role {
  Customer = 'customer',
  Agent = 'agent',
  ApprovalsOfficer = 'approvals_officer',
  ProductEditor = 'product_editor',
  CountryManager = 'country_manager',
  SuperAdmin = 'super_admin',
}
