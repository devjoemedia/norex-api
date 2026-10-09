import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Min } from 'class-validator';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateBrandDto {
  @IsString() @Length(1, 80) name!: string;
  @Matches(SLUG, { message: 'slug must be kebab-case' }) slug!: string;
}

export class CreateCategoryDto {
  @IsString() @Length(1, 80) name!: string;
  @Matches(SLUG, { message: 'slug must be kebab-case' }) slug!: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
