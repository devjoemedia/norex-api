import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportingService } from './reporting.service';
import { ApplicationsReportDto } from './dto/reporting.dto';

// Cross-tenant / global aggregates behind the explicit, audited super_admin bypass
// (docs/01, docs/13). Not tenant-scoped by design; every read is audited in the service.
@Controller('admin/reports')
@Roles(Role.SuperAdmin)
export class AdminReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('cross-tenant/applications')
  crossTenantApplications(@CurrentUser() actor: AuthUser, @Query() q: ApplicationsReportDto) {
    return this.reporting.crossTenantApplications(actor, q);
  }
}
