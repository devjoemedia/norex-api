import { Controller, Headers, HttpCode, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { NotificationsService } from './notifications.service';

// Provider delivery/read receipts. Signature-verified over the raw body before any
// status is mutated (docs/10).
@Controller('webhooks/notifications')
export class NotificationWebhooksController {
  constructor(private readonly notifications: NotificationsService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  handle(
    @TenantId() tenantId: string,
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature?: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    return this.notifications.handleWebhook(tenantId, provider, raw, signature);
  }
}
