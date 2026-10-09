import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportingService } from './reporting.service';
import { RollupSchedulerService } from './rollup-scheduler.service';
import {
  ApplicationsReportDto,
  CreateExportDto,
  FinanceReportDto,
  InventoryReportDto,
  LeaseReturnsReportDto,
  ListExportsDto,
  RefreshRollupsDto,
} from './dto/reporting.dto';

// Per-tenant dashboards + on-demand exports. Every route is authenticated and
// role-gated; reads come from rollups only and never expose customer PII (docs/13).
@Controller('reports')
export class ReportingController {
  constructor(
    private readonly reporting: ReportingService,
    private readonly scheduler: RollupSchedulerService,
  ) {}

  @Get('applications')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  applications(@TenantId() tenantId: string, @Query() q: ApplicationsReportDto) {
    return this.reporting.applications(tenantId, q);
  }

  @Get('finance')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  finance(@TenantId() tenantId: string, @Query() q: FinanceReportDto) {
    return this.reporting.finance(tenantId, q);
  }

  @Get('inventory')
  @Roles(Role.CountryManager, Role.ProductEditor, Role.SuperAdmin)
  inventory(@TenantId() tenantId: string, @Query() q: InventoryReportDto) {
    return this.reporting.inventory(tenantId, q);
  }

  @Get('lease-returns')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  leaseReturns(@TenantId() tenantId: string, @Query() q: LeaseReturnsReportDto) {
    return this.reporting.leaseReturns(tenantId, q);
  }

  // Manual refresh of the report rollups for this country (e.g. after a data fix).
  @Post('refresh')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  async refresh(@TenantId() tenantId: string, @Body() dto: RefreshRollupsDto) {
    const days = await this.scheduler.run(dto.days ?? 30, [tenantId]);
    return { refreshedDays: days };
  }

  @Post('exports')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  createExport(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateExportDto,
  ) {
    return this.reporting.createExport(actor, tenantId, dto);
  }

  // Declared before ':jobId' so the literal path wins the route match.
  @Get('exports')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  listExports(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Query() q: ListExportsDto,
  ) {
    return this.reporting.listExports(actor, tenantId, q.status, q.limit);
  }

  @Get('exports/:jobId')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  getExport(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    return this.reporting.getExport(actor, tenantId, jobId);
  }
}
