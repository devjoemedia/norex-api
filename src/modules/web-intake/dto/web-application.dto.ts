import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApplicationType } from '@prisma/client';
import { GuarantorDto } from '../../kyc/dto/kyc.dto';
import { INTAKE_FILE_KINDS } from '../intake-files';

export class WebApplicantDto {
  @IsString() @Length(2, 120) fullName!: string;

  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone!: string;

  @IsOptional() @IsEmail() email?: string;
}

export class WebDeviceDto {
  @IsString() @Length(1, 160) slug!: string;
  @IsOptional() @IsString() @Length(1, 40) storage?: string;
  @IsOptional() @IsString() @Length(1, 60) color?: string;
}

export class WebIdentityDto {
  // The website's value: national-id | passport | drivers-license.
  @IsString() @Length(2, 40) idType!: string;
  @IsString() @Length(3, 40) idNumber!: string;
  @IsOptional() @IsObject() address?: Record<string, unknown>;
  @IsOptional() @IsObject() employment?: Record<string, unknown>;
}

export class WebTradeInDto {
  @IsString() @Length(1, 60) oldBrand!: string;
  @IsString() @Length(1, 120) oldModel!: string;
  @IsOptional() @IsString() @Length(1, 40) oldStorage?: string;
  @IsOptional() @IsString() @Length(1, 40) conditionCode?: string;
  @IsOptional() @IsString() @Length(0, 300) accessories?: string;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
}

export class WebFileDto {
  @IsIn(INTAKE_FILE_KINDS) kind!: string;
  // base64 data URL; the size and image type are checked when decoded.
  @IsString() @MaxLength(4_500_000) dataUrl!: string;
}

// A guest application from the website's form, posted by the website's server.
export class WebApplicationDto {
  @IsEnum(ApplicationType) type!: ApplicationType;

  // Stamped by the website before submit so WhatsApp, email and the API match.
  @Matches(/^(BNP|LSE|TRD)-[A-HJ-NP-Z2-9]{6}$/, { message: 'reference format is invalid' })
  reference!: string;

  @ValidateNested() @Type(() => WebApplicantDto) applicant!: WebApplicantDto;
  @ValidateNested() @Type(() => WebDeviceDto) device!: WebDeviceDto;

  @IsOptional() @IsInt() @Min(1) @Max(60) financeMonths?: number;
  @IsOptional() @IsInt() @Min(0) upfrontMinor?: number;
  @IsOptional() @IsInt() leaseMonths?: number;

  @IsOptional() @ValidateNested() @Type(() => WebIdentityDto) identity?: WebIdentityDto;
  @IsOptional() @ValidateNested() @Type(() => GuarantorDto) guarantor?: GuarantorDto;
  @IsOptional() @ValidateNested() @Type(() => WebTradeInDto) tradeIn?: WebTradeInDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INTAKE_FILE_KINDS.length)
  @ValidateNested({ each: true })
  @Type(() => WebFileDto)
  files?: WebFileDto[];

  // Everything else the form collected (payout, fulfilment, consents, file names).
  // Stored encrypted on the application for staff.
  @IsOptional() @IsObject() extras?: Record<string, unknown>;
}
