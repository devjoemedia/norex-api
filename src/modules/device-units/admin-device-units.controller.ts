import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { DeviceUnitsService } from './device-units.service';
import {
  BulkRegisterDto,
  ListDeviceUnitsDto,
  RegisterDeviceUnitDto,
  RevealImeiDto,
} from './dto/device-unit.dto';

const VIEWERS = [
  Role.SuperAdmin,
  Role.CountryManager,
  Role.ApprovalsOfficer,
  Role.ProductEditor, // Operations
  Role.Agent,
];

// Devices by IMEI for the portal (docs/18). Lists show the masked IMEI only; the
// full number needs a reason and is limited to managers.
@Controller('admin/device-units')
export class AdminDeviceUnitsController {
  constructor(
    private readonly units: DeviceUnitsService,
    private readonly all: AllCountriesService,
  ) {}

  @Roles(...VIEWERS)
  @AllowAllTenants()
  @Get()
  list(@TenantScope() scope: TenantScopeValue, @Query() q: ListDeviceUnitsDto) {
    return this.all.listing(scope, (t) => this.units.list(t, q));
  }

  @Roles(...VIEWERS)
  @Get(':id')
  detail(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.units.detail(tenantId, id);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent)
  @Post('bulk')
  registerMany(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkRegisterDto,
  ) {
    return this.units.registerMany(tenantId, user, dto);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent)
  @Post()
  register(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceUnitDto,
  ) {
    return this.units.register(tenantId, user, dto);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager)
  @Post(':id/reveal')
  @HttpCode(200)
  reveal(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevealImeiDto,
  ) {
    return this.units.reveal(tenantId, user, id, dto.reason);
  }
}
