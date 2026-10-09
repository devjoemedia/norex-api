import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { FinancingService } from './financing.service';
import { CreatePlanDto, UpdateRulesDto, UpdateTermDto } from './dto/finance.dto';

// Plan/rate management — country_manager writes, rate changes are history-tracked and audited.
@Controller('finance/plans')
export class AdminFinancingController {
  constructor(private readonly financing: FinancingService) {}

  @Get()
  @Roles(Role.CountryManager, Role.ProductEditor)
  list(@TenantId() tenantId: string) {
    return this.financing.listPlans(tenantId);
  }

  @Post()
  @Roles(Role.CountryManager)
  create(@TenantId() tenantId: string, @CurrentUser() actor: AuthUser, @Body() dto: CreatePlanDto) {
    return this.financing.createPlan(actor, tenantId, dto);
  }

  @Patch(':planId/terms/:termId')
  @Roles(Role.CountryManager)
  updateTerm(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('termId', ParseUUIDPipe) termId: string,
    @Body() dto: UpdateTermDto,
  ) {
    return this.financing.updateTerm(actor, tenantId, planId, termId, dto);
  }

  @Put(':planId/rules')
  @Roles(Role.CountryManager)
  updateRules(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdateRulesDto,
  ) {
    return this.financing.updateRules(actor, tenantId, planId, dto);
  }

  @Post(':planId/activate')
  @Roles(Role.CountryManager)
  activate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.financing.activate(actor, tenantId, planId);
  }
}
