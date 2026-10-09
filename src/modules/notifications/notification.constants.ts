import { NotificationCategory, NotificationChannel, NotificationEventKey } from '@prisma/client';

export const DEFAULT_LOCALE = 'en';

// Each event's category (transactional is always sent; marketing honours opt-out) and
// the channels it may use. Category is a property of the event, never client-supplied.
export interface EventConfig {
  category: NotificationCategory;
  channels: NotificationChannel[];
  // Variable allow-list — rendering fails closed on any variable outside this set.
  vars: string[];
}

export const EVENTS: Record<NotificationEventKey, EventConfig> = {
  otp: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.sms],
    vars: ['code', 'ttlMinutes'],
  },
  application_status: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.sms, NotificationChannel.email],
    vars: ['reference', 'status', 'reason', 'fullName'],
  },
  payment_reminder: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.sms, NotificationChannel.email],
    vars: ['reference', 'amount', 'currency', 'dueDate', 'fullName'],
  },
  payment_receipt: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.sms, NotificationChannel.email],
    vars: ['receiptNumber', 'amount', 'currency', 'fullName'],
  },
  trade_in_quote_ready: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.sms, NotificationChannel.email],
    vars: ['reference', 'quoteAmount', 'currency', 'topUp', 'fullName'],
  },
  marketing: {
    category: NotificationCategory.marketing,
    channels: [NotificationChannel.email, NotificationChannel.sms],
    vars: ['fullName', 'title', 'message'],
  },
};

export interface DefaultTemplate {
  subject?: string;
  body: string;
}

// Final fallback when a tenant has no active template for an (event, channel). Keeps
// transactional messages sending even before any template is authored (docs/10).
export const PLATFORM_DEFAULTS: Partial<
  Record<NotificationEventKey, Partial<Record<NotificationChannel, DefaultTemplate>>>
> = {
  otp: {
    sms: { body: 'Your Norex code is {{code}}. It expires in {{ttlMinutes}} minutes.' },
  },
  application_status: {
    sms: { body: 'Norex: application {{reference}} is now {{status}}.' },
    email: {
      subject: 'Your Norex application {{reference}}',
      body: 'Hello {{fullName}}, your application {{reference}} is now {{status}}.',
    },
  },
  payment_reminder: {
    sms: { body: 'Norex: {{amount}} {{currency}} for {{reference}} is due on {{dueDate}}.' },
    email: {
      subject: 'Payment reminder — {{reference}}',
      body: 'Hello {{fullName}}, {{amount}} {{currency}} for {{reference}} is due on {{dueDate}}.',
    },
  },
  payment_receipt: {
    sms: { body: 'Norex receipt {{receiptNumber}}: {{amount}} {{currency}} received. Thank you.' },
    email: {
      subject: 'Your Norex receipt {{receiptNumber}}',
      body: 'Hello {{fullName}}, we received {{amount}} {{currency}}. Receipt {{receiptNumber}}.',
    },
  },
  trade_in_quote_ready: {
    sms: { body: 'Norex: your trade-in quote for {{reference}} is {{quoteAmount}} {{currency}}.' },
  },
};

// Per-recipient, per-day caps by category (beyond the global throttle). Excess is
// suppressed and logged, never silently dropped.
export const DAILY_CAPS: Record<NotificationCategory, number> = {
  [NotificationCategory.transactional]: 50,
  [NotificationCategory.marketing]: 5,
};
