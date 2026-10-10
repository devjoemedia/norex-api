import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { StockTransferStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { StockTransfersService } from './stock-transfers.service';

class ListTransfersDto {
  @IsOptional() @IsEnum(StockTransferStatus) status?: StockTransferStatus;
}

class AvailableUnitsDto {
  // "warehouse" or an outlet id.
  @IsString() @Length(1, 40) from!: string;
  @IsOptional() @IsString() @Length(1, 40) q?: string;
}

class CreateTransferDto {
  @IsOptional() @IsUUID() fromBranchId?: string;
  @IsUUID() toBranchId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('4', { each: true }) unitIds!: string[];
  @IsOptional() @IsString() @Length(0, 300) note?: string;
}

const MOVERS = [Role.SuperAdmin, Role.CountryManager, Role.ProductEditor];
const VIEWERS = [...MOVERS, Role.Agent];

// Stock moving between the warehouse and outlets (docs/22).
@Controller('admin/transfers')
export class AdminTransfersController {
  constructor(
    private readonly transfers: StockTransfersService,
    private readonly all: AllCountriesService,
  ) {}

  @Roles(...VIEWERS)
  @AllowAllTenants()
  @Get()
  list(@TenantScope() scope: TenantScopeValue, @Query() q: ListTransfersDto) {
    return this.all.listing(scope, (t) => this.transfers.list(t, q.status));
  }

  @Roles(...MOVERS)
  @Get('available')
  available(@TenantId() tenantId: string, @Query() q: AvailableUnitsDto) {
    return this.transfers.available(tenantId, q.from === 'warehouse' ? null : q.from, q.q);
  }

  @Roles(...VIEWERS)
  @Get(':id')
  detail(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.detail(tenantId, id);
  }

  @Roles(...MOVERS)
  @Post()
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTransferDto,
  ) {
    return this.transfers.create(tenantId, user, dto);
  }

  @Roles(...VIEWERS)
  @Post(':id/receive')
  @HttpCode(200)
  receive(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transfers.receive(tenantId, user, id);
  }

  @Roles(...MOVERS)
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transfers.cancel(tenantId, user, id);
  }
}
