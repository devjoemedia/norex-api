import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { OrdersService } from './orders.service';
import {
  CourierDto,
  ListOrdersDto,
  OrderActionDto,
  OrderHandoverDto,
  OrderPaymentDto,
  RefundDecisionDto,
  RefundRequestDto,
} from './dto/order.dto';

const STAFF = [
  Role.SuperAdmin,
  Role.CountryManager,
  Role.ApprovalsOfficer,
  Role.ProductEditor, // Operations
  Role.Agent,
];
// Support reads orders (list and detail) but can't act on them.
const VIEWERS = [...STAFF, Role.Support];
const COUNTER = [Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent]; // take cash, hand over

// Cash orders from the website cart (docs/18).
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly all: AllCountriesService,
  ) {}

  @Roles(...VIEWERS)
  @AllowAllTenants()
  @Get()
  list(@TenantScope() scope: TenantScopeValue, @Query() q: ListOrdersDto) {
    return this.all.listing(scope, (t) => this.orders.list(t, q));
  }

  @Roles(...VIEWERS)
  @Get(':id')
  detail(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.detail(tenantId, id);
  }

  @Roles(...STAFF)
  @Post(':id/action')
  @HttpCode(200)
  act(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderActionDto,
  ) {
    return this.orders.act(tenantId, user, id, dto);
  }

  @Roles(...COUNTER)
  @Post(':id/payment')
  @HttpCode(200)
  payment(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderPaymentDto,
  ) {
    return this.orders.recordPayment(tenantId, user, id, dto.amountMinor);
  }

  @Roles(...COUNTER)
  @Post(':id/handover')
  @HttpCode(200)
  handover(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderHandoverDto,
  ) {
    return this.orders.handover(tenantId, user, id, dto);
  }

  // ---------- delivery and refunds (docs/23) ----------

  @Roles(...COUNTER)
  @Post(':id/courier')
  @HttpCode(200)
  courier(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CourierDto,
  ) {
    return this.orders.assignCourier(tenantId, user, id, dto);
  }

  @Roles(...COUNTER)
  @Post(':id/refunds')
  @HttpCode(200)
  requestRefund(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundRequestDto,
  ) {
    return this.orders.requestRefund(tenantId, user, id, dto);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager)
  @Get('refunds/pending')
  pendingRefunds(@TenantId() tenantId: string) {
    return this.orders.pendingRefunds(tenantId);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager)
  @Post('refunds/:refundId/decision')
  @HttpCode(200)
  decideRefund(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('refundId', ParseUUIDPipe) refundId: string,
    @Body() dto: RefundDecisionDto,
  ) {
    return this.orders.decideRefund(tenantId, user, refundId, dto);
  }
}
