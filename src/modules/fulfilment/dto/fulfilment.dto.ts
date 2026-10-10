import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { IdVerifyMethod } from '@prisma/client';

export class LookupDto {
  @IsString() @Length(3, 40) reference!: string;
}

export class VerifyIdDto {
  @IsIn(Object.values(IdVerifyMethod)) method!: IdVerifyMethod;
  @IsOptional() @IsString() @Length(0, 500) note?: string;
}

export class HandoverDto {
  @IsOptional() @IsString() @Length(0, 120) serial?: string;
  // Validated (15 digits + Luhn) and encrypted by ImeiService; never stored plain.
  @IsOptional() @IsString() @Length(15, 24) imei?: string;
  @IsOptional() @IsString() @Length(0, 500) note?: string;
}

export class ListFulfilmentDto {
  @IsOptional() @IsString() status?: string;
}
