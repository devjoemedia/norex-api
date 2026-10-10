import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { Role } from '../../common/enums/role.enum';
import { PosService } from './pos.service';

class LookupDto {
  @IsString() @Length(3, 60) q!: string;
}

class StockDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() deviceId?: string;
  @IsOptional() @IsString() @Length(1, 40) q?: string;
}

class BranchDto {
  @IsOptional() @IsUUID() branchId?: string;
}

class PaymentInDto {
  @IsIn(['cash', 'momo']) method!: 'cash' | 'momo';
  @IsOptional() @IsString() @Length(1, 60) reference?: string;
  @IsInt() @Min(1) amountMinor!: number;
}

class IdCheckDto {
  @IsIn(['kyc_match', 'manual_override']) method!: 'kyc_match' | 'manual_override';
  @IsOptional() @IsString() @Length(0, 500) note?: string;
}

class SignatureDto {
  @IsString() @Length(2, 120) name!: string;
  @IsString() @Length(30, 420_000) imageDataUrl!: string;
}

class HandoverDto {
  @IsUUID() applicationId!: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsUUID() unitId!: string;
  @ValidateNested() @Type(() => IdCheckDto) idCheck!: IdCheckDto;
  @ValidateNested() @Type(() => SignatureDto) signature!: SignatureDto;
  @IsOptional() @ValidateNested() @Type(() => PaymentInDto) deposit?: PaymentInDto;
}

class CashCustomerDto {
  @IsString() @Length(2, 120) fullName!: string;
  @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'Enter a valid phone number' }) phone!: string;
  @IsOptional() @IsEmail() email?: string;
}

class CashSaleDto {
  @IsOptional() @IsUUID() branchId?: string;
  @ValidateNested() @Type(() => CashCustomerDto) customer!: CashCustomerDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsUUID('4', { each: true }) unitIds!: string[];
  @ValidateNested() @Type(() => PaymentInDto) payment!: PaymentInDto;
}

class RepaymentDto extends PaymentInDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsUUID() scheduleId!: string;
}

const COUNTER = [Role.Agent, Role.CountryManager, Role.SuperAdmin];

// Selling at an outlet: hand over approved plans, cash sales and repayments (docs/21).
@Controller('admin/pos')
@Roles(...COUNTER)
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get('lookup')
  lookup(@TenantId() tenantId: string, @Query() q: LookupDto) {
    return this.pos.lookup(tenantId, q.q);
  }

  @Get('stock')
  async stock(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Query() q: StockDto) {
    const branchId = await this.pos.outletFor(tenantId, user, q.branchId);
    return this.pos.stock(tenantId, branchId, { deviceId: q.deviceId, q: q.q });
  }

  @Get('today')
  today(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Query() q: BranchDto) {
    return this.pos.today(tenantId, user, q.branchId);
  }

  @Get('agreement/:applicationId')
  agreement(
    @TenantId() tenantId: string,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
  ) {
    return this.pos.agreementPreview(tenantId, applicationId);
  }

  @Post('handover')
  @HttpCode(200)
  handover(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Body() dto: HandoverDto) {
    return this.pos.handover(tenantId, user, dto);
  }

  @Post('cash-sale')
  @HttpCode(200)
  cashSale(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Body() dto: CashSaleDto) {
    return this.pos.cashSale(tenantId, user, dto);
  }

  @Post('repayment')
  @HttpCode(200)
  repayment(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RepaymentDto,
  ) {
    return this.pos.repayment(tenantId, user, dto);
  }
}
