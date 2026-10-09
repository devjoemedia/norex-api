import { Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { ContentRefType, ContentStatus, ContentType } from '@prisma/client';

const CONTENT_TYPES = Object.values(ContentType);
const CONTENT_STATUSES = Object.values(ContentStatus);
const REF_TYPES = Object.values(ContentRefType);

export class ContentReferenceInput {
  @IsIn(REF_TYPES) refType!: ContentRefType;
  @IsString() @Length(1, 200) refId!: string;
}

export class CreateContentDto {
  @IsIn(CONTENT_TYPES) type!: ContentType;
  @IsOptional() @IsString() @Length(1, 200) slug?: string;
  @IsOptional() @IsString() @Length(2, 20) locale?: string;
  @IsOptional() @IsString() @Length(1, 300) title?: string;
  @IsObject() body!: Record<string, unknown>;
  @IsOptional() @IsObject() meta?: Record<string, unknown>;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContentReferenceInput)
  references?: ContentReferenceInput[];
}

export class UpdateContentDto {
  @IsOptional() @IsString() @Length(1, 300) title?: string;
  @IsOptional() @IsObject() body?: Record<string, unknown>;
  @IsOptional() @IsObject() meta?: Record<string, unknown>;
}

export class PublishDto {
  @IsOptional() @IsISO8601() publishAt?: string;
}

export class RevertDto {
  @IsInt() @Min(1) version!: number;
}

export class ListContentDto {
  @IsOptional() @IsIn(CONTENT_TYPES) type?: ContentType;
  @IsOptional() @IsIn(CONTENT_STATUSES) status?: ContentStatus;
  @IsOptional() @IsString() @Length(2, 20) locale?: string;
  @IsOptional() @IsString() @Length(1, 200) slug?: string;
}

export class MediaSignDto {
  @IsString() contentType!: string;
  @IsOptional() @IsString() @Length(1, 300) filename?: string;
  @IsOptional() @IsInt() @Min(1) bytes?: number;
}

export class SiteConfigDto {
  @IsString() @Length(1, 200) key!: string;
  // Arbitrary JSON value (string/number/object/array); @IsDefined keeps it on whitelist.
  @IsDefined() value!: unknown;
}
