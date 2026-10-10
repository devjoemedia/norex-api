import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { SmsService } from '../sms.service';
import { ChannelAdapter, RenderedMessage, SendResult } from './channel.interface';

// SMS channel. No gateway is connected yet (docs/10): the message is logged in
// development, and the delivery log records it as failed (`sms_not_configured`)
// instead of pretending it went. Connect a provider in SmsService to switch it on.
@Injectable()
export class SmsAdapter implements ChannelAdapter {
  readonly channel = NotificationChannel.sms;

  constructor(private readonly sms: SmsService) {}

  async send(to: string, message: RenderedMessage): Promise<SendResult> {
    await this.sms.send(to, message.body);
    throw new Error('sms_not_configured');
  }
}
