import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RecoveryStatus } from '@prisma/client';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { Role } from '../../common/enums/role.enum';
import { Outcome, RecoveryService } from './recovery.service';

class ListDto {
  @IsOptional() @IsIn(['open', 'promised', 'assigned', 'closed', 'all']) status?:
    RecoveryStatus | 'all';
}
class NoteDto {
  @IsIn(['call', 'visit', 'message']) kind!: 'call' | 'visit' | 'message';
  @IsString() @Length(2, 1000) text!: string;
}
class PromiseDto {
  @IsISO8601() date!: string;
  @IsInt() @Min(1) amountMinor!: number;
}
class AssignDto {
  @IsUUID() userId!: string;
}
class CloseDto {
  @IsIn(['paid_up', 'repossessed', 'written_off', 'other']) outcome!: Outcome;
  @IsString() @Length(3, 500) note!: string;
}

const STAFF = [Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent];

// Recovery cases for plans more than a week behind (docs/24). Agents see only the
// cases assigned to them; managers and compliance see and run them all.
@Controller('admin/recovery')
@Roles(...STAFF)
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Get()
  list(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Query() q: ListDto) {
    return this.recovery.list(tenantId, user, q.status);
  }

  @Get(':id')
  detail(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recovery.detail(tenantId, user, id);
  }

  @Post(':id/notes')
  @HttpCode(200)
  note(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NoteDto,
  ) {
    return this.recovery.addNote(tenantId, user, id, dto);
  }

  @Post(':id/promise')
  @HttpCode(200)
  promise(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PromiseDto,
  ) {
    return this.recovery.promise(tenantId, user, id, dto);
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDto,
  ) {
    return this.recovery.assign(tenantId, user, id, dto.userId);
  }

  @Post(':id/close')
  @HttpCode(200)
  close(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseDto,
  ) {
    return this.recovery.closeByStaff(tenantId, user, id, dto);
  }
}
