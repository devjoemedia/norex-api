import { Module } from '@nestjs/common';
import { SmsService } from './sms.service';
import { NotificationsService } from './notifications.service';
import { ChannelRegistry } from './channels/channel.registry';
import { EmailAdapter } from './channels/email.adapter';
import { SmsAdapter } from './channels/sms.adapter';
import { WhatsAppAdapter } from './channels/whatsapp.adapter';
import { PushAdapter } from './channels/push.adapter';
import { NotificationsController } from './notifications.controller';
import { AdminNotificationsController } from './admin-notifications.controller';
import { NotificationWebhooksController } from './notification-webhooks.controller';

@Module({
  controllers: [
    NotificationsController,
    AdminNotificationsController,
    NotificationWebhooksController,
  ],
  providers: [
    SmsService,
    NotificationsService,
    ChannelRegistry,
    EmailAdapter,
    SmsAdapter,
    WhatsAppAdapter,
    PushAdapter,
  ],
  // SmsService stays exported for auth OTP; NotificationsService is the producer API.
  exports: [SmsService, NotificationsService],
})
export class NotificationsModule {}
