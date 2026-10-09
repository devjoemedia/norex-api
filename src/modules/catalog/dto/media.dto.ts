import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class MediaUploadUrlDto {
  @IsString() @Length(1, 100) contentType!: string;
  @IsInt() @Min(1) bytes!: number;
}

export class ConfirmMediaDto {
  @IsString() @Length(1, 400) s3Key!: string;
  @IsOptional() @IsString() @Length(0, 200) altText?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
