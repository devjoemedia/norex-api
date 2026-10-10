import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { PayoutsService } from './payouts.service';

class CreateBatchDto {
  @IsIn(['agent', 'outlet']) payeeType!: 'agent' | 'outlet';
  @IsUUID() payeeId!: string;
}

class MarkPaidDto {
  @IsIn(['momo', 'bank', 'cash']) method!: 'momo' | 'bank' | 'cash';
  @IsOptional() @IsString() @Length(1, 80) paymentRef?: string;
}

const FINANCE = [Role.SuperAdmin, Role.CountryManager, Role.ProductEditor];

// Commissions and outlet fees owed and paid (docs/23).
@Controller('admin/payouts')
export class AdminPayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly all: AllCountriesService,
  ) {}

  @Roles(...FINANCE)
  @AllowAllTenants()
  @Get()
  overview(@TenantScope() scope: TenantScopeValue) {
    return this.all.perCountry(scope, (t) => this.payouts.overview(t));
  }

  // An agent's own earnings.
  @Roles(Role.Agent)
  @Get('mine')
  mine(@TenantId() tenantId: string, @CurrentUser() user: AuthUser) {
    return this.payouts.mine(tenantId, user.id);
  }

  @Roles(...FINANCE)
  @Post('batches')
  createBatch(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBatchDto,
  ) {
    return this.payouts.createBatch(tenantId, user, dto.payeeType, dto.payeeId);
  }

  @Roles(Role.SuperAdmin, Role.CountryManager)
  @Post('batches/:id/paid')
  @HttpCode(200)
  markPaid(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPaidDto,
  ) {
    return this.payouts.markPaid(tenantId, user, id, dto);
  }
}
