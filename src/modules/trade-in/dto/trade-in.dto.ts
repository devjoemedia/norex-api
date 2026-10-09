import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { TradeInPhotoKind } from '@prisma/client';

const PHOTO_KINDS = Object.values(TradeInPhotoKind);

// ISO date-string that must resolve to a moment in the future (quote expiry).
function IsFutureDateString(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isFutureDateString',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const t = Date.parse(value);
          return !Number.isNaN(t) && t > Date.now();
        },
        defaultMessage: () => 'expiresAt must be an ISO date-string in the future',
      },
    });
}

export class CreateTradeInDto {
  @IsUUID() targetDeviceId!: string;
  @IsOptional() @IsUUID() targetVariantId?: string;
  @IsString() @Length(1, 120) oldBrand!: string;
  @IsString() @Length(1, 120) oldModel!: string;
  @IsOptional() @IsString() @Length(1, 60) oldStorage?: string;
  @IsOptional() @IsString() @Length(1, 60) conditionCode?: string;
  @IsOptional() @IsObject() accessories?: Record<string, unknown>;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string;
}

// Draft-only edits to the old-device details.
export class UpdateTradeInDto {
  @IsOptional() @IsUUID() targetVariantId?: string;
  @IsOptional() @IsString() @Length(1, 120) oldBrand?: string;
  @IsOptional() @IsString() @Length(1, 120) oldModel?: string;
  @IsOptional() @IsString() @Length(1, 60) oldStorage?: string;
  @IsOptional() @IsString() @Length(1, 60) conditionCode?: string;
  @IsOptional() @IsObject() accessories?: Record<string, unknown>;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string;
}

export class PhotoUploadUrlDto {
  @IsString() contentType!: string;
  @IsInt() @Min(1) bytes!: number;
  @IsIn(PHOTO_KINDS) kind!: TradeInPhotoKind;
}

export class ConfirmPhotoDto {
  @IsString() @Length(1, 1024) s3Key!: string;
  @IsIn(PHOTO_KINDS) kind!: TradeInPhotoKind;
}

export class ListTradeInsDto {
  @IsOptional() @IsString() status?: string;
}

export class ValuationDto {
  @IsInt() @Min(0) quoteValueMinor!: number;
  @IsOptional() @IsInt() @Min(0) topUpMinor?: number;
  @IsDateString() @IsFutureDateString() expiresAt!: string;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string;
}

export class ConditionOptionInput {
  @IsString() @Length(1, 60) code!: string;
  @IsString() @Length(1, 120) label!: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ConditionOptionsDto {
  @IsArray()
  @ArrayNotEmpty()
  @Type(() => ConditionOptionInput)
  options!: ConditionOptionInput[];
}
