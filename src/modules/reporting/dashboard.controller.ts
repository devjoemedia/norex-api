import { Controller, Get } from '@nestjs/common';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { DashboardService } from './dashboard.service';

// Admin portal home aggregates for one country. With `X-Tenant: all` a Super Admin
// gets one dashboard per country side by side — never summed across currencies.
@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly all: AllCountriesService,
  ) {}

  @Roles(
    Role.SuperAdmin,
    Role.CountryManager,
    Role.ApprovalsOfficer,
    Role.ProductEditor,
    Role.Agent,
  )
  @AllowAllTenants()
  @Get()
  get(@TenantScope() scope: TenantScopeValue) {
    return this.all.perCountry(scope, (t) => this.dashboard.getDashboard(t));
  }
}
