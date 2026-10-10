import { Controller, Get } from '@nestjs/common';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { SystemHealthService } from './system-health.service';

// Integration and job health for the Super Admin (docs/26).
@Controller('admin/system')
@Roles(Role.SuperAdmin)
export class SystemController {
  constructor(
    private readonly health: SystemHealthService,
    private readonly all: AllCountriesService,
  ) {}

  @AllowAllTenants()
  @Get('health')
  async overview(@TenantScope() scope: TenantScopeValue) {
    return {
      platform: this.health.platform(),
      countries: await this.all.perCountry(scope, (t) => this.health.country(t)),
    };
  }
}
