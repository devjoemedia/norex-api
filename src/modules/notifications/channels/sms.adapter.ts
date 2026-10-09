import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationChannel } from '@prisma/client';
import { SmsService } from '../sms.service';
import { ChannelAdapter, RenderedMessage, SendResult } from './channel.interface';

// SMS channel — wraps the existing SmsService seam (also used by auth OTP).
@Injectable()
export class SmsAdapter implements ChannelAdapter {
  readonly channel = NotificationChannel.sms;

  constructor(private readonly sms: SmsService) {}

  async send(to: string, message: RenderedMessage): Promise<SendResult> {
    await this.sms.send(to, message.body);
    return { providerMessageId: `sms_${randomUUID()}` };
  }
}
