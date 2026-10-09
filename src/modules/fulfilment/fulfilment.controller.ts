import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { FulfilmentService } from './fulfilment.service';
import { HandoverDto, ListFulfilmentDto, LookupDto, VerifyIdDto } from './dto/fulfilment.dto';

// In-branch fulfilment flow. All routes are agent-gated by role AND a resource-level
// branch-ownership check in the service; the branch queue is also visible to managers.
@Controller('fulfilment')
export class FulfilmentController {
  constructor(private readonly fulfilment: FulfilmentService) {}

  @Get('lookup')
  @Roles(Role.Agent)
  lookup(@TenantId() tenantId: string, @CurrentUser() actor: AuthUser, @Query() q: LookupDto) {
    return this.fulfilment.lookup(tenantId, actor, q.reference);
  }

  @Post(':applicationId/verify-id')
  @Roles(Role.Agent)
  verifyId(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() dto: VerifyIdDto,
  ) {
    return this.fulfilment.verifyId(tenantId, actor, applicationId, dto);
  }

  @Post(':applicationId/handover')
  @Roles(Role.Agent)
  handover(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() dto: HandoverDto,
  ) {
    return this.fulfilment.handover(tenantId, actor, applicationId, dto);
  }

  @Get()
  @Roles(Role.Agent, Role.CountryManager)
  list(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Query() q: ListFulfilmentDto,
  ) {
    return this.fulfilment.list(tenantId, actor, q.status);
  }
}
