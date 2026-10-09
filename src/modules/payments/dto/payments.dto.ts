import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { InstallmentStatus, PaymentChannel, PaymentPurpose } from '@prisma/client';

export class InitiatePaymentDto {
  @IsEnum(PaymentPurpose) purpose!: PaymentPurpose;

  // Required for installment / lease_fee; omitted for a deposit (no schedule yet).
  @IsOptional() @IsUUID() installmentId?: string;

  // Required for a deposit, so the pre-schedule payment links to its application.
  @IsOptional() @IsUUID() applicationId?: string;

  @IsInt() @IsPositive() amountMinor!: number;

  @IsString() @Length(2, 32) provider!: string;

  @IsEnum(PaymentChannel) channel!: PaymentChannel;
}

export class ListInstallmentsDto {
  @IsOptional() @IsEnum(InstallmentStatus) status?: InstallmentStatus;
}

export class RefundDto {
  @IsInt() @IsPositive() amountMinor!: number;
  @IsString() @Length(3, 200) reason!: string;
}

export class ReconciliationDto {
  @IsOptional() @Type(() => Date) from?: Date;
  @IsOptional() @Type(() => Date) to?: Date;
}

export class ArrearsDto {
  @IsOptional() @IsInt() @Min(0) minDaysOverdue?: number;
}

export class ConfigureProviderDto {
  @IsString() @Length(2, 32) provider!: string;
  @IsString() @Length(16, 200) webhookSecret!: string;
}
