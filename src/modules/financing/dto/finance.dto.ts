import { Type } from 'class-transformer';
import { FinanceFeeMode } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class QuoteDto {
  @IsUUID() deviceId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(60) months!: number;
  // Optional custom upfront (minor units, 20–80% of cash) — FLEX plans only.
  @Type(() => Number) @IsOptional() @IsInt() @Min(0) upfrontMinor?: number;
}

export class PlanTermInput {
  @IsInt() @Min(1) @Max(60) months!: number;
  @IsInt() @Min(0) @Max(10000) depositPctBps!: number; // 0–100%
  @IsInt() @Min(0) @Max(10000) monthlyMarkupBps!: number;
  @IsOptional() @IsEnum(FinanceFeeMode) feeMode?: FinanceFeeMode;
  @IsOptional() @IsInt() @Min(0) @Max(10000) premiumBps?: number;
  @IsOptional() @IsInt() @Min(0) minPremiumMinor?: number;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class EligibilityRuleInput {
  @IsOptional() @IsInt() @Min(0) minPriceMinor?: number;
  @IsOptional() @IsInt() @Min(0) maxPriceMinor?: number;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsBoolean() requireInStock?: boolean;
}

export class CreatePlanDto {
  @IsString() @Length(2, 80) name!: string;
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PlanTermInput)
  terms!: PlanTermInput[];
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EligibilityRuleInput)
  rules?: EligibilityRuleInput[];
}

export class UpdateTermDto {
  @IsOptional() @IsInt() @Min(1) @Max(60) months?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) depositPctBps?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) monthlyMarkupBps?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) premiumBps?: number;
  @IsOptional() @IsInt() @Min(0) minPremiumMinor?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateRulesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EligibilityRuleInput)
  rules!: EligibilityRuleInput[];
}
