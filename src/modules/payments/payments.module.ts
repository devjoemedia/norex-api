import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsService } from './payments.service';
import { LedgerService } from './ledger.service';
import { ProviderRegistry } from './providers/provider.registry';
import { PaymentsController } from './payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [NotificationsModule],
  controllers: [PaymentsController, AdminPaymentsController, WebhooksController],
  providers: [PaymentsService, LedgerService, ProviderRegistry],
  exports: [PaymentsService],
})
export class PaymentsModule {}
