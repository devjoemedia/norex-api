import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { TradeInService } from './trade-in.service';
import { ConditionOptionsDto, ValuationDto } from './dto/trade-in.dto';

// Staff manual valuation + per-tenant condition-options config (audited). Static
// 'condition-options' routes are declared before ':id' so they are not captured by it.
@Controller('admin/trade-in')
export class AdminTradeInController {
  constructor(private readonly tradeIn: TradeInService) {}

  @Get('condition-options')
  @Roles(Role.CountryManager)
  listConditionOptions(@TenantId() tenantId: string) {
    return this.tradeIn.listConditionOptions(tenantId);
  }

  @Patch('condition-options')
  @Roles(Role.CountryManager)
  upsertConditionOptions(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: ConditionOptionsDto,
  ) {
    return this.tradeIn.upsertConditionOptions(actor, tenantId, dto);
  }

  @Post(':id/valuation')
  @Roles(Role.Agent, Role.CountryManager)
  valuate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ValuationDto,
  ) {
    return this.tradeIn.valuate(actor, tenantId, id, dto);
  }
}
