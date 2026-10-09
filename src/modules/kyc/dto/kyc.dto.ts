import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, Length, Min } from 'class-validator';
import { KycDocKind, KycStatus } from '@prisma/client';

export enum VerifyDecision {
  verify = 'verify',
  reject = 'reject',
}

export class KycProfileDto {
  @IsString() @Length(2, 40) idTypeCode!: string;
  @IsString() @Length(3, 40) idNumber!: string;
  @IsObject() address!: Record<string, unknown>;
  @IsObject() employment!: Record<string, unknown>;
}

export class GuarantorDto {
  @IsString() @Length(2, 120) fullName!: string;
  @IsString() @Length(6, 20) phone!: string;
  @IsString() @Length(2, 60) relationship!: string;
  @IsOptional() @IsObject() address?: Record<string, unknown>;
}

export class UploadDocDto {
  @IsEnum(KycDocKind) kind!: KycDocKind;
  @IsString() @Length(1, 100) contentType!: string;
  @IsInt() @Min(1) bytes!: number;
}

export class ConfirmDocDto {
  @IsEnum(KycDocKind) kind!: KycDocKind;
  @IsString() @Length(1, 400) storageKey!: string;
  @IsString() @Length(1, 100) contentType!: string;
  @IsInt() @Min(1) bytes!: number;
  @IsOptional() @IsString() @Length(64, 64) sha256?: string;
}

export class VerifyDto {
  @IsEnum(VerifyDecision) decision!: VerifyDecision;
  @IsOptional() @IsString() @Length(1, 500) reason?: string;
}

export class ListProfilesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit = 20;
  @IsOptional() @IsEnum(KycStatus) status?: KycStatus;
}
