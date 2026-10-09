import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { InitiatePaymentDto, ListInstallmentsDto } from './dto/payments.dto';

// Customer-facing payments. Reads have no @Roles — any authenticated user may call, and
// the service enforces ownership (staff may read across the tenant).
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('schedules/:id')
  getSchedule(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payments.getSchedule(tenantId, user, id);
  }

  @Get('me/installments')
  @Roles(Role.Customer)
  myInstallments(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() q: ListInstallmentsDto,
  ) {
    return this.payments.myInstallments(tenantId, user, q.status);
  }

  @Post('payments/initiate')
  @Roles(Role.Customer)
  @HttpCode(201)
  initiate(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: InitiatePaymentDto,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    return this.payments.initiate(tenantId, user, dto, idemKey);
  }

  @Get('payments/:id')
  getPayment(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payments.getPayment(tenantId, user, id);
  }

  @Get('payments/:id/receipt')
  receipt(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payments.receiptUrl(tenantId, user, id);
  }
}
