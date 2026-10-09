import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { Role } from '@prisma/client';

export class AssignRoleDto {
  @IsEnum(Role)
  role!: Role;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}
