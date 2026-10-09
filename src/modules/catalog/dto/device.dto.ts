import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { DeviceStatus } from '@prisma/client';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateDeviceDto {
  @IsUUID() brandId!: string;
  @IsUUID() categoryId!: string;
  @IsString() @Length(2, 120) name!: string;
  @Matches(SLUG, { message: 'slug must be kebab-case' }) slug!: string;
  @IsOptional() @IsString() @Length(0, 500) summary?: string;
  @IsInt() @Min(0) cashPriceMinor!: number;
  // Optional: always the country's currency; sending a different one is rejected.
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsOptional() @IsBoolean() financeEligible?: boolean;
  @IsOptional() @IsBoolean() leaseEligible?: boolean;
  @IsOptional() @IsBoolean() tradeInEligible?: boolean;
  @IsOptional() @IsObject() specs?: Record<string, unknown>;
}

export class UpdateDeviceDto {
  @IsOptional() @IsUUID() brandId?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 500) summary?: string;
  @IsOptional() @IsInt() @Min(0) cashPriceMinor?: number;
  @IsOptional() @IsBoolean() financeEligible?: boolean;
  @IsOptional() @IsBoolean() leaseEligible?: boolean;
  @IsOptional() @IsBoolean() tradeInEligible?: boolean;
  @IsOptional() @IsObject() specs?: Record<string, unknown>;
}

export class PublicListDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit = 20;
  @IsOptional() @IsString() brand?: string; // slug
  @IsOptional() @IsString() category?: string; // slug
  @IsOptional() @IsString() @Length(1, 80) q?: string;
  @IsOptional() @IsString() storage?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minPriceMinor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxPriceMinor?: number;
  @IsOptional() @IsIn(['price', 'newest', 'name']) sort?: 'price' | 'newest' | 'name';
}

export class AdminListDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit = 20;
  @IsOptional() @IsEnum(DeviceStatus) status?: DeviceStatus;
  @IsOptional() @IsString() @Length(1, 80) q?: string;
}
