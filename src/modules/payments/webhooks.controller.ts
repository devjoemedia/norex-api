import { Controller, Headers, HttpCode, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { PaymentsService } from './payments.service';

// The only public route in this module. It does no work before verifying the provider
// signature over the raw request body (docs/09).
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(private readonly payments: PaymentsService) {}

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
    return this.payments.handleWebhook(tenantId, provider, raw, signature);
  }
}
