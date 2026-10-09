import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { ChannelAdapter } from './channel.interface';
import { EmailAdapter } from './email.adapter';
import { SmsAdapter } from './sms.adapter';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { PushAdapter } from './push.adapter';

@Injectable()
export class ChannelRegistry {
  private readonly byChannel: Map<NotificationChannel, ChannelAdapter>;

  constructor(email: EmailAdapter, sms: SmsAdapter, whatsapp: WhatsAppAdapter, push: PushAdapter) {
    const adapters: ChannelAdapter[] = [email, sms, whatsapp, push];
    this.byChannel = new Map(adapters.map((a) => [a.channel, a]));
  }

  get(channel: NotificationChannel): ChannelAdapter {
    const adapter = this.byChannel.get(channel);
    if (!adapter) throw new Error(`No adapter for channel ${channel}`);
    return adapter;
  }
}
