import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { LeaseReturnGrade } from '@prisma/client';
import { LEASE_TERMS } from '../lease.calculator';

const LEASE_MONTHS = LEASE_TERMS as readonly number[];

export class LeaseQuoteDto {
  @IsUUID() deviceId!: string;
  @IsIn(LEASE_MONTHS) months!: number;
}

export class ListLeasesDto {
  @IsOptional() @IsString() status?: string;
}

export class LeaseReturnDto {
  @IsIn(Object.values(LeaseReturnGrade)) conditionGrade!: LeaseReturnGrade;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) photoKeys?: string[];
  @IsOptional() @IsInt() @Min(0) feeAdjustmentMinor?: number;
}

export class LeaseUpgradeDto {
  @IsUUID() newDeviceId!: string;
}

export class LeaseRateTermInput {
  @IsIn(LEASE_MONTHS) months!: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) monthlyFeeBps?: number;
  @IsOptional() @IsInt() @Min(0) monthlyFeeMinor?: number;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsInt() @Min(0) minPriceMinor?: number;
  @IsOptional() @IsInt() @Min(0) maxPriceMinor?: number;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class CreateLeaseConfigDto {
  @IsString() @Length(2, 80) name!: string;
  @IsArray()
  @ArrayNotEmpty()
  @Type(() => LeaseRateTermInput)
  terms!: LeaseRateTermInput[];
}

export class UpdateLeaseTermDto {
  @IsOptional() @IsInt() @Min(0) @Max(10000) monthlyFeeBps?: number;
  @IsOptional() @IsInt() @Min(0) monthlyFeeMinor?: number;
  @IsOptional() @IsInt() @Min(0) minPriceMinor?: number;
  @IsOptional() @IsInt() @Min(0) maxPriceMinor?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class TermsTemplateDto {
  @IsString() @Length(2, 10000) usageTerms!: string;
  @IsString() @Length(2, 10000) returnConditions!: string;
  @IsString() @Length(2, 10000) noOwnershipNotice!: string;
}
