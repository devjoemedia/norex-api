import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { BranchStatus, BranchType } from '@prisma/client';

export class ListBranchesDto {
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsIn(Object.values(BranchType)) type?: BranchType;
}

export class CreateBranchDto {
  @IsString() @Length(2, 120) name!: string;
  @IsIn(Object.values(BranchType)) type!: BranchType;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() @Length(0, 500) address?: string;
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsObject() hours?: Record<string, unknown>;
  @IsOptional() @IsString() phone?: string;
}

export class UpdateBranchDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsIn(Object.values(BranchType)) type?: BranchType;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() @Length(0, 500) address?: string;
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsObject() hours?: Record<string, unknown>;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsIn(Object.values(BranchStatus)) status?: BranchStatus;
}

export class AssignAgentDto {
  @IsUUID() userId!: string;
}
