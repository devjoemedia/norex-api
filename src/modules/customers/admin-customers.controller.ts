import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { AdminPermissions } from '../../common/auth/admin-permissions';
import { CustomersService } from './customers.service';
import { searchKindsFor } from './search-access';

class SearchDto {
  @IsString()
  @Length(2, 80)
  q!: string;
}

const ALL_STAFF = [
  Role.SuperAdmin,
  Role.CountryManager,
  Role.ApprovalsOfficer,
  Role.ProductEditor,
  Role.Agent,
  Role.Support,
];
const CUSTOMER_VIEWERS = [
  Role.SuperAdmin,
  Role.CountryManager,
  Role.ApprovalsOfficer,
  Role.Agent,
  Role.Support,
];

@Controller('admin')
export class AdminCustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly all: AllCountriesService,
  ) {}

  // Topbar search. Results are limited to what the caller may open (search-access.ts).
  @Roles(...ALL_STAFF)
  @AllowAllTenants()
  @Get('search')
  search(
    @TenantScope() scope: TenantScopeValue,
    @CurrentUser() user: AuthUser,
    @Query() q: SearchDto,
  ) {
    const kinds = searchKindsFor(user.roles, user.permissions as AdminPermissions | undefined);
    return this.all.array(scope, (t) => this.customers.search(t, q.q, kinds));
  }

  @Roles(...CUSTOMER_VIEWERS)
  @Get('customers/:id')
  detail(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.detail(tenantId, id);
  }
}
