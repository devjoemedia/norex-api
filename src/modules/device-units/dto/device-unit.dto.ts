import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { DeviceUnitStatus } from '@prisma/client';

export class ListDeviceUnitsDto {
  @IsOptional() @IsEnum(DeviceUnitStatus) status?: DeviceUnitStatus;
  // A full IMEI, its last 4 digits, or part of a serial.
  @IsOptional() @IsString() @Length(1, 40) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 100;
}

export class RegisterDeviceUnitDto {
  @IsString() @Length(15, 24) imei!: string; // spaces/dashes allowed; checked with Luhn
  @IsOptional() @IsString() @Length(1, 60) serial?: string;
  @IsUUID() deviceId!: string;
  @IsOptional() @IsUUID() variantId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsString() @Length(0, 300) notes?: string;
}

export class RevealImeiDto {
  @IsString() @Length(5, 200) reason!: string;
}
