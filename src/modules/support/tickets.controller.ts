import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { Role } from '../../common/enums/role.enum';
import { TicketsService } from './tickets.service';

const CATEGORIES = ['payment', 'device', 'application', 'order', 'account', 'other'];
const CHANNELS = ['phone', 'whatsapp', 'walk_in', 'email'];
const PRIORITIES = ['low', 'normal', 'high'];

class ListDto {
  @IsOptional() @IsIn(['open', 'pending', 'resolved', 'all']) status?: TicketStatus | 'all';
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  mine?: boolean;
}
class CreateDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsString() @Length(3, 160) subject!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  @IsIn(CHANNELS) channel!: string;
  @IsString() @Length(2, 4000) message!: string;
}
class ReplyDto {
  @IsString() @Length(1, 4000) body!: string;
}
class UpdateDto {
  @IsOptional() @IsIn(['open', 'pending', 'resolved']) status?: TicketStatus;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() assignedToId?: string | null;
}

const SUPPORT = [
  Role.SuperAdmin,
  Role.CountryManager,
  Role.Support,
  Role.ApprovalsOfficer,
  Role.Agent,
];

// Support tickets (docs/25).
@Controller('admin/tickets')
@Roles(...SUPPORT)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Query() q: ListDto) {
    return this.tickets.list(tenantId, q, user);
  }

  @Get(':id')
  detail(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.detail(tenantId, id);
  }

  @Post()
  create(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Body() dto: CreateDto) {
    return this.tickets.create(tenantId, user, dto);
  }

  @Post(':id/messages')
  reply(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplyDto,
  ) {
    return this.tickets.reply(tenantId, user, id, dto.body);
  }

  @Patch(':id')
  update(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDto,
  ) {
    return this.tickets.update(tenantId, user, id, dto);
  }
}
