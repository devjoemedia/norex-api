import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@prisma/client';
import { ChannelAdapter, RenderedMessage, SendResult } from './channel.interface';

// WhatsApp channel seam (Meta Cloud API). Free-form outside the session window is
// rejected upstream; live sends use provider-approved template names (docs/10).
@Injectable()
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = NotificationChannel.whatsapp;
  private readonly logger = new Logger('WhatsApp');

  constructor(private readonly config: ConfigService) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(to: string, message: RenderedMessage): Promise<SendResult> {
    if (this.config.get<string>('NODE_ENV') !== 'production') {
      this.logger.log(`WHATSAPP -> ${to}: ${message.body}`);
    }
    // No WhatsApp provider is connected yet: record a failure, not a fake send.
    throw new Error('whatsapp_not_configured');
  }
}
