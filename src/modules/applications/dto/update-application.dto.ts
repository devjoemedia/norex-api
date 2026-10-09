import { IsInt, IsObject, IsOptional, IsUUID, Max, Min } from 'class-validator';

// Editable only while the application is a draft or has info requested.
export class UpdateApplicationDto {
  @IsOptional()
  @IsUUID()
  deviceId?: string;

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
