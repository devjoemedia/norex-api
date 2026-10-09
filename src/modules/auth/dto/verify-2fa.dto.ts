import {
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class Verify2faDto {
  @IsUUID()
  challengeId!: string;

  @IsOptional()
  @IsNumberString({ no_symbols: true })
  @Length(6, 6)
  totp?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(40)
  recoveryCode?: string;
}
