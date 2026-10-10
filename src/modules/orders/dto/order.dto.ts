import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '@prisma/client';
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES, ORDER_REFERENCE } from '../order.constants';

// ---- website → API (POST /web/orders) ----
export class WebOrderCustomerDto {
  @IsString() @Length(2, 120) fullName!: string;
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone!: string;
  @IsOptional() @IsEmail() email?: string;
}

export class WebOrderItemDto {
  @IsString() @Length(1, 160) slug!: string;
  @IsOptional() @IsString() @Length(1, 40) storage?: string;
  @IsOptional() @IsString() @Length(1, 60) color?: string;
  @IsInt() @Min(1) @Max(MAX_LINE_QUANTITY) quantity!: number;
}

export class WebOrderFulfilmentDto {
  @IsIn(['pickup', 'delivery']) method!: 'pickup' | 'delivery';
  @IsOptional() @IsString() @Length(1, 80) region?: string;
  @IsOptional() @IsString() @Length(1, 120) branch?: string;
  @ValidateIf((f: WebOrderFulfilmentDto) => f.method === 'delivery')
  @IsString()
  @Length(3, 300)
  address?: string;
}

export class WebOrderDto {
  @Matches(ORDER_REFERENCE, { message: 'reference format is invalid' }) reference!: string;
  @ValidateNested() @Type(() => WebOrderCustomerDto) customer!: WebOrderCustomerDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => WebOrderItemDto)
  items!: WebOrderItemDto[];

  @ValidateNested() @Type(() => WebOrderFulfilmentDto) fulfilment!: WebOrderFulfilmentDto;
  @IsOptional() @IsString() @Length(0, 500) notes?: string;
}

// ---- admin ----
export class ListOrdersDto {
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
}

export class OrderActionDto {
  @IsIn(['confirm', 'ready', 'cancel']) action!: 'confirm' | 'ready' | 'cancel';
  @IsOptional() @IsUUID() branchId?: string;
  @ValidateIf((d: OrderActionDto) => d.action === 'cancel')
  @IsString()
  @Length(3, 300)
  reason?: string;
}

export class OrderPaymentDto {
  // Cash taken, in minor units. Must cover the order total (pay in full).
  @IsInt() @Min(1) amountMinor!: number;
}

export class HandoverUnitDto {
  @IsUUID() itemId!: string;
  // Phones/tablets: IMEI (validated + encrypted). Others: serial only.
  @IsOptional() @IsString() @Length(15, 24) imei?: string;
  @IsOptional() @IsString() @Length(1, 60) serial?: string;
}

export class OrderHandoverDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES * MAX_LINE_QUANTITY)
  @ValidateNested({ each: true })
  @Type(() => HandoverUnitDto)
  units!: HandoverUnitDto[];
}
