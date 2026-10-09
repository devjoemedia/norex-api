import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@prisma/client';
import { ChannelAdapter, RenderedMessage, SendResult } from './channel.interface';

// Push channel seam (FCM/APNs). `to` is the device token; live resolves the FCM service
// account / APNs key from the secret manager (docs/10).
@Injectable()
export class PushAdapter implements ChannelAdapter {
  readonly channel = NotificationChannel.push;
  private readonly logger = new Logger('Push');

  constructor(private readonly config: ConfigService) {}

  async send(to: string, message: RenderedMessage): Promise<SendResult> {
    if (this.config.get<string>('NODE_ENV') !== 'production') {
      this.logger.log(`PUSH -> ${to.slice(0, 8)}…: ${message.body}`);
    }
    return { providerMessageId: `push_${randomUUID()}` };
  }
}
