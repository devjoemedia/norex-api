import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { OrdersService } from './orders.service';
import { ListOrdersDto, OrderActionDto, OrderHandoverDto, OrderPaymentDto } from './dto/order.dto';

const STAFF = [
  Role.SuperAdmin,
  Role.CountryManager,
  Role.ApprovalsOfficer,
  Role.ProductEditor, // Operations
  Role.Agent,
];
const COUNTER = [Role.SuperAdmin, Role.CountryManager, Role.ProductEditor, Role.Agent]; // take cash, hand over

// Cash orders from the website cart (docs/18).
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly all: AllCountriesService,
  ) {}

  @Roles(...STAFF)
  @AllowAllTenants()
  @Get()
  list(@TenantScope() scope: TenantScopeValue, @Query() q: ListOrdersDto) {
    return this.all.listing(scope, (t) => this.orders.list(t, q));
  }

  @Roles(...STAFF)
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
}
