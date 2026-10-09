import { Body, Controller, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { SetStatusDto } from './dto/set-status.dto';
import { ListUsersQueryDto } from './dto/list-users.dto';
import { CreateStaffDto } from './dto/create-staff.dto';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.getProfile(user.id, user.tenantId);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    // Phone changes go through a dedicated OTP re-verify flow (not this endpoint).
    return this.users.updateProfile(user.id, user.tenantId, dto);
  }

  @Post('admin/staff')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  createStaff(
    @CurrentUser() actor: AuthUser,
    @TenantId() tenantId: string,
    @Body() dto: CreateStaffDto,
    @Ip() ip: string,
  ) {
    return this.users.createStaff(actor, tenantId, dto, ip);
  }

  @Get('admin/users')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  list(@TenantId() tenantId: string, @Query() query: ListUsersQueryDto) {
    return this.users.list(tenantId, query);
  }

  @Patch('admin/users/:id')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  setStatus(
    @CurrentUser() actor: AuthUser,
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @Ip() ip: string,
  ) {
    return this.users.setStatus(actor, tenantId, id, dto.status, ip);
  }

  @Post('admin/users/:id/roles')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  assignRole(
    @CurrentUser() actor: AuthUser,
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
    @Ip() ip: string,
  ) {
    return this.users.assignRole(actor, tenantId, id, dto.role, dto.branchId, ip);
  }
}
