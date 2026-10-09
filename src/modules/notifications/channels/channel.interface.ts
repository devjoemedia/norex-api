import { NotificationChannel } from '@prisma/client';

export interface RenderedMessage {
  subject?: string;
  body: string;
}

export interface SendResult {
  providerMessageId: string;
}

// One channel's transport. Dev adapters log and return a synthetic message id; a live
// provider resolves credentials from the secret manager (docs/10) — never from the DB.
export interface ChannelAdapter {
  readonly channel: NotificationChannel;
  send(to: string, message: RenderedMessage): Promise<SendResult>;
}
