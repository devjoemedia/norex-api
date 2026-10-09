import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { RegisterPushTokenDto, UpdatePreferenceDto } from './dto/notifications.dto';

// Self-scoped preferences + device tokens. Any authenticated user; the service enforces
// that a user only ever touches their own rows.
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('preferences')
  getPreferences(@TenantId() tenantId: string, @CurrentUser() user: AuthUser) {
    return this.notifications.getPreferences(tenantId, user.id);
  }

  @Patch('preferences')
  updatePreference(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePreferenceDto,
  ) {
    return this.notifications.updatePreference(tenantId, user.id, dto);
  }

  @Post('push-tokens')
  registerPushToken(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterPushTokenDto,
  ) {
    return this.notifications.registerPushToken(tenantId, user.id, dto);
  }

  @Delete('push-tokens/:id')
  revokePushToken(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.revokePushToken(tenantId, user.id, id);
  }
}
