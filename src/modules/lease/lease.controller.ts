import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { LeaseService } from './lease.service';
import { LeaseReturnDto, LeaseUpgradeDto, ListLeasesDto } from './dto/lease.dto';

// Customer lease reads (own) + staff lifecycle actions. Ownership for customers is
// enforced in the service, not by role alone.
@Controller('leases')
export class LeaseController {
  constructor(private readonly lease: LeaseService) {}

  @Get()
  list(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Query() q: ListLeasesDto) {
    return this.lease.list(tenantId, user, q.status);
  }

  @Get(':id')
  getOne(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lease.getOne(tenantId, user, id);
  }

  @Post(':id/return')
  @Roles(Role.Agent, Role.CountryManager)
  returnLease(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeaseReturnDto,
  ) {
    return this.lease.returnLease(actor, tenantId, id, dto);
  }

  @Post(':id/upgrade')
  @Roles(Role.Agent, Role.CountryManager)
  upgrade(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeaseUpgradeDto,
  ) {
    return this.lease.upgradeLease(actor, tenantId, id, dto);
  }
}
