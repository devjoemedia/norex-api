import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateVariantDto {
  @IsString() @Length(1, 60) sku!: string;
  @IsOptional() @IsString() @Length(1, 40) storage?: string;
  @IsOptional() @IsString() @Length(1, 40) color?: string;
  @IsOptional() @IsInt() priceDeltaMinor?: number;
  @IsOptional() @IsInt() @Min(0) stockQty?: number;
}

export class UpdateVariantDto {
  @IsOptional() @IsString() @Length(1, 40) storage?: string;
  @IsOptional() @IsString() @Length(1, 40) color?: string;
  @IsOptional() @IsInt() @Min(0) stockQty?: number;
  @IsOptional() @IsInt() priceDeltaMinor?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
