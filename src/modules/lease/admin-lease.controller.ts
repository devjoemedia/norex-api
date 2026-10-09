import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { LeaseService } from './lease.service';
import { CreateLeaseConfigDto, TermsTemplateDto, UpdateLeaseTermDto } from './dto/lease.dto';

// Lease rate/terms management — country_manager writes; rate edits are history-tracked
// and audited (mirrors financing admin).
@Controller('admin/lease')
export class AdminLeaseController {
  constructor(private readonly lease: LeaseService) {}

  @Get('configs')
  @Roles(Role.CountryManager, Role.ProductEditor)
  listConfigs(@TenantId() tenantId: string) {
    return this.lease.listConfigs(tenantId);
  }

  @Post('configs')
  @Roles(Role.CountryManager)
  createConfig(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateLeaseConfigDto,
  ) {
    return this.lease.createConfig(actor, tenantId, dto);
  }

  @Post('configs/:id/activate')
  @Roles(Role.CountryManager)
  activate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lease.activateConfig(actor, tenantId, id);
  }

  @Patch('configs/:id/terms/:termId')
  @Roles(Role.CountryManager)
  updateTerm(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('termId', ParseUUIDPipe) termId: string,
    @Body() dto: UpdateLeaseTermDto,
  ) {
    return this.lease.updateTerm(actor, tenantId, id, termId, dto);
  }

  @Get('terms-template')
  @Roles(Role.CountryManager, Role.ProductEditor)
  listTermsTemplates(@TenantId() tenantId: string) {
    return this.lease.listTermsTemplates(tenantId);
  }

  @Post('terms-template')
  @Roles(Role.CountryManager)
  createTermsTemplate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: TermsTemplateDto,
  ) {
    return this.lease.createTermsTemplate(actor, tenantId, dto);
  }
}
