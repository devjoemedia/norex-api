import { IsEnum, IsInt, IsObject, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApplicationType } from '@prisma/client';

export class CreateApplicationDto {
  @IsEnum(ApplicationType)
  type!: ApplicationType;

  @IsUUID()
  deviceId!: string;

  @IsOptional()
  @IsObject()
  planSnapshot?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  financeMonths?: number;

  @IsOptional()
  @IsInt()
  leaseMonths?: number;

  // Custom upfront (minor units, 20–80% of cash), FLEX financing only; checked at submit.
  @IsOptional()
  @IsInt()
  @Min(0)
  upfrontMinor?: number;

  @IsOptional()
  @IsUUID()
  tradeInId?: string;
}
