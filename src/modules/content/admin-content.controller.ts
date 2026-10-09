import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ContentService } from './content.service';
import {
  CreateContentDto,
  ListContentDto,
  MediaSignDto,
  PublishDto,
  RevertDto,
  SiteConfigDto,
  UpdateContentDto,
} from './dto/content.dto';

// Authoring surface — all statuses, role-gated to editors/managers, every write audited
// (docs/11). Literal routes (media/sign, config) are declared before ':id' routes so
// they aren't captured as an id.
@Controller('admin/content')
@Roles(Role.ProductEditor, Role.CountryManager)
export class AdminContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  list(@TenantId() tenantId: string, @Query() q: ListContentDto) {
    return this.content.adminList(tenantId, q);
  }

  @Post()
  create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateContentDto,
  ) {
    return this.content.create(actor, tenantId, dto);
  }

  @Post('media/sign')
  mediaSign(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: MediaSignDto,
  ) {
    return this.content.mediaSign(actor, tenantId, dto);
  }

  @Get('config')
  getConfig(@TenantId() tenantId: string, @Query('key') key?: string) {
    return this.content.getSiteConfig(tenantId, key);
  }

  @Put('config')
  setConfig(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: SiteConfigDto,
  ) {
    return this.content.setSiteConfig(actor, tenantId, dto);
  }

  @Patch(':id')
  update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContentDto,
  ) {
    return this.content.update(actor, tenantId, id, dto);
  }

  @Post(':id/publish')
  publish(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishDto,
  ) {
    return this.content.publish(actor, tenantId, id, dto);
  }

  @Post(':id/unpublish')
  unpublish(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.content.unpublish(actor, tenantId, id);
  }

  @Get(':id/versions')
  versions(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.versions(tenantId, id);
  }

  @Post(':id/revert')
  revert(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevertDto,
  ) {
    return this.content.revert(actor, tenantId, id, dto.version);
  }
}
