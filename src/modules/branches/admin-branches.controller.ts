import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { BranchesService } from './branches.service';
import { AssignAgentDto, CreateBranchDto, UpdateBranchDto } from './dto/branches.dto';

// Branch management + agent assignment — country_manager / super_admin, tenant-scoped.
@Controller('admin/branches')
@Roles(Role.CountryManager, Role.SuperAdmin)
export class AdminBranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  list(@TenantId() tenantId: string) {
    return this.branches.listAll(tenantId);
  }

  @Post()
  create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateBranchDto,
  ) {
    return this.branches.create(actor, tenantId, dto);
  }

  @Patch(':id')
  update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branches.update(actor, tenantId, id, dto);
  }

  @Post(':id/agents')
  assignAgent(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignAgentDto,
  ) {
    return this.branches.assignAgent(actor, tenantId, id, dto);
  }

  @Delete(':id/agents/:userId')
  unassignAgent(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.branches.unassignAgent(actor, tenantId, id, userId);
  }
}
