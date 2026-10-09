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
  @IsOptional() @IsString() @Length(0, 120) imei?: string;
  @IsOptional() @IsString() @Length(0, 500) note?: string;
}

export class ListFulfilmentDto {
  @IsOptional() @IsString() status?: string;
}
