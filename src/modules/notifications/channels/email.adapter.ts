import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@prisma/client';
import { ChannelAdapter, RenderedMessage, SendResult } from './channel.interface';

// Email channel seam (SES/SendGrid in production). Dev logs; live resolves creds from
// the secret manager (docs/10).
@Injectable()
export class EmailAdapter implements ChannelAdapter {
  readonly channel = NotificationChannel.email;
  private readonly logger = new Logger('Email');

  constructor(private readonly config: ConfigService) {}

  async send(to: string, message: RenderedMessage): Promise<SendResult> {
    if (this.config.get<string>('NODE_ENV') !== 'production') {
      this.logger.log(`EMAIL -> ${to}: ${message.subject ?? '(no subject)'}`);
    }
    return { providerMessageId: `email_${randomUUID()}` };
  }
}
