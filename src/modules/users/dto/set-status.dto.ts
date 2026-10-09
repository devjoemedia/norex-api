import { IsEnum } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class SetStatusDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}
