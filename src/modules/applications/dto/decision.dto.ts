import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DecisionAction } from '../application.constants';

export class DecisionDto {
  @IsEnum(DecisionAction)
  decision!: DecisionAction;

  // Required by the service for request_info / decline.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
