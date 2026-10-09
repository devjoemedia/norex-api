import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { ConfigureProviderDto, ReconciliationDto, RefundDto } from './dto/payments.dto';

@Controller('admin')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('reconciliation')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  reconciliation(@TenantId() tenantId: string, @Query() q: ReconciliationDto) {
    return this.payments.reconciliation(tenantId, q.from, q.to);
  }

  @Get('arrears')
  @Roles(Role.Agent, Role.ApprovalsOfficer, Role.CountryManager)
  arrears(@TenantId() tenantId: string) {
    return this.payments.arrears(tenantId);
  }

  @Post('payments/:id/refund')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  refund(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundDto,
  ) {
    return this.payments.refund(tenantId, actor, id, dto);
  }

  // Not under payments/: GET /admin/payments/:id would catch it.
  @Get('payment-providers')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  listProviders(@TenantId() tenantId: string) {
    return this.payments.listProviders(tenantId);
  }

  @Post('payments/providers')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  configureProvider(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: ConfigureProviderDto,
  ) {
    return this.payments.configureProvider(tenantId, actor, dto.provider, dto.webhookSecret);
  }
}
