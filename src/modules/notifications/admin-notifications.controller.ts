import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import {
  ConfigureChannelProviderDto,
  CreateTemplateDto,
  ListNotificationsDto,
  ListTemplatesDto,
  TestSendDto,
  UpdateTemplateDto,
} from './dto/notifications.dto';

@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('catalog')
  @Roles(Role.ProductEditor, Role.CountryManager)
  catalog() {
    return this.notifications.catalog();
  }

  @Get('templates')
  @Roles(Role.ProductEditor, Role.CountryManager)
  listTemplates(@TenantId() tenantId: string, @Query() q: ListTemplatesDto) {
    return this.notifications.listTemplates(tenantId, q);
  }

  @Post('templates')
  @Roles(Role.ProductEditor, Role.CountryManager)
  createTemplate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateTemplateDto,
  ) {
    return this.notifications.createTemplate(tenantId, actor, dto);
  }

  @Patch('templates/:id')
  @Roles(Role.ProductEditor, Role.CountryManager)
  updateTemplate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.notifications.updateTemplate(tenantId, actor, id, dto);
  }

  @Post('test')
  @Roles(Role.ProductEditor, Role.CountryManager)
  testSend(@TenantId() tenantId: string, @CurrentUser() actor: AuthUser, @Body() dto: TestSendDto) {
    return this.notifications.testSend(tenantId, actor, dto);
  }

  @Get()
  @Roles(Role.CountryManager, Role.SuperAdmin)
  list(@TenantId() tenantId: string, @Query() q: ListNotificationsDto) {
    return this.notifications.listNotifications(tenantId, q);
  }

  @Post('providers')
  @Roles(Role.CountryManager, Role.SuperAdmin)
  configureProvider(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: ConfigureChannelProviderDto,
  ) {
    return this.notifications.configureProvider(tenantId, actor, dto);
  }
}
