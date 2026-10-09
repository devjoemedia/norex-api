import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { AdminService } from './admin.service';

// Admin portal read-models and edits for one country (X-Tenant / host). A Super Admin
// may send `X-Tenant: all` to the list GETs marked @AllowAllTenants (docs/15).
// Class default: Super Admin + Country Manager; some routes also let in country staff.
@Roles(Role.SuperAdmin, Role.CountryManager)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly all: AllCountriesService,
  ) {}

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent)
  @AllowAllTenants()
  @Get('applications')
  applications(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.applications(t));
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent)
  @Get('applications/:id')
  applicationDetail(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.applicationDetail(tenantId, id);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent)
  @AllowAllTenants()
  @Get('customers')
  customers(@TenantScope() scope: TenantScopeValue) {
    return this.all.array(scope, (t) => this.admin.customers(t));
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent)
  @Post('applications')
  createApplication(@TenantId() tenantId: string, @Body() body: never) {
    return this.admin.createApplication(tenantId, body);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer)
  @Post('applications/:id/decision')
  decideApplication(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: { decision: 'approve' | 'reject'; reason?: string },
  ) {
    return this.admin.decideApplication(tenantId, id, body.decision, body.reason);
  }

  // NOTE: /admin/users is already owned by UsersController, so the portal's
  // read-model lives at /admin/all-users to avoid the route clash.
  @AllowAllTenants()
  @Get('all-users')
  users(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.users(t));
  }

  @Get('all-users/:id')
  userDetail(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.userDetail(tenantId, id);
  }

  @Post('all-users')
  createUser(
    @TenantId() tenantId: string,
    @CurrentUser('roles') roles: string[],
    @Body() body: never,
  ) {
    return this.admin.createUser(tenantId, body, roles);
  }

  @Patch('all-users/:id')
  updateUser(
    @TenantId() tenantId: string,
    @CurrentUser('roles') roles: string[],
    @Param('id') id: string,
    @Body() body: never,
  ) {
    return this.admin.updateUser(tenantId, id, body, roles);
  }

  @Post('all-users/:id/status')
  setUserStatus(
    @TenantId() tenantId: string,
    @CurrentUser('roles') roles: string[],
    @Param('id') id: string,
    @Body() body: { status: 'active' | 'suspended' },
  ) {
    return this.admin.setUserStatus(tenantId, id, body.status, roles);
  }

  @Post('all-users/:id/reset-sign-in')
  resetSignIn(
    @TenantId() tenantId: string,
    @CurrentUser('roles') roles: string[],
    @Param('id') id: string,
  ) {
    return this.admin.resetSignIn(tenantId, id, roles);
  }

  @Delete('all-users/:id')
  deleteUser(
    @TenantId() tenantId: string,
    @CurrentUser('roles') roles: string[],
    @Param('id') id: string,
  ) {
    return this.admin.deleteUser(tenantId, id, roles);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent)
  @AllowAllTenants()
  @Get('kyc')
  kyc(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.kyc(t));
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent)
  @Get('kyc/:id')
  kycDetail(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.kycDetail(tenantId, id);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer)
  @Post('kyc/:id/decision')
  decideKyc(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: { decision: 'verify' | 'reject'; reason?: string },
  ) {
    return this.admin.decideKyc(tenantId, id, body.decision, body.reason);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent)
  @AllowAllTenants()
  @Get('inventory')
  inventory(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.inventory(t));
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent)
  @Get('inventory/:id')
  inventoryDetail(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.inventoryDetail(tenantId, id);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor)
  @Post('inventory')
  createProduct(@TenantId() tenantId: string, @Body() body: never) {
    return this.admin.createProduct(tenantId, body);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor)
  @Patch('inventory/:id')
  updateProduct(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: never) {
    return this.admin.updateProduct(tenantId, id, body);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor)
  @Delete('inventory/:id')
  deleteProduct(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.deleteProduct(tenantId, id);
  }

  // NOTE: /admin/branches is owned by the existing BranchesModule, so the portal's
  // branch-management surface lives under /admin/branch-management.
  @AllowAllTenants()
  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent)
  @Get('branch-management')
  branches(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.branches(t));
  }

  @AllowAllTenants()
  @Get('branch-admins')
  branchAdmins(@TenantScope() scope: TenantScopeValue) {
    return this.all.array(scope, (t) => this.admin.branchAdmins(t));
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent)
  @Get('branch-management/:id')
  branchDetail(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.branchDetail(tenantId, id);
  }

  @Post('branch-management/:id/assign-admin')
  assignBranchAdmin(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: { userId: string },
  ) {
    return this.admin.assignBranchAdmin(tenantId, id, body.userId);
  }

  @Post('branch-management')
  createBranch(@TenantId() tenantId: string, @Body() body: never) {
    return this.admin.createBranch(tenantId, body);
  }

  @Patch('branch-management/:id')
  updateBranch(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: never) {
    return this.admin.updateBranch(tenantId, id, body);
  }

  @Delete('branch-management/:id')
  deleteBranch(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.deleteBranch(tenantId, id);
  }

  @AllowAllTenants()
  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.ProductEditor)
  @Get('activity-log')
  activityLog(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.activityLog(t));
  }

  @AllowAllTenants()
  @Get('agents')
  agents(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.agents(t));
  }

  @AllowAllTenants()
  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent)
  @Get('pickups')
  pickups(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.pickups(t));
  }

  // Arrears ageing (PAR). Read-only: never marks installments or sends reminders.
  @AllowAllTenants()
  @Roles(
    Role.SuperAdmin,
    Role.CountryManager,
    Role.ApprovalsOfficer,
    Role.ProductEditor,
    Role.Agent,
  )
  @Get('collections')
  collections(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.collections(t));
  }

  @AllowAllTenants()
  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.ProductEditor)
  @Get('payments')
  payments(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, (t) => this.admin.payments(t));
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.ProductEditor)
  @Get('payments/:id')
  paymentDetail(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.admin.paymentDetail(tenantId, id);
  }
}
