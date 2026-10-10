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
  // Customer updates on applications and buy now orders. Email only until an SMS
  // provider is live (docs/10); the copy lives in PLATFORM_DEFAULTS below and each
  // country can override it in the portal's Template manager.
  application_received: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.email],
    vars: ['fullName', 'reference', 'kind', 'product', 'plan', 'country'],
  },
  application_approved: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.email],
    vars: ['fullName', 'reference', 'kind', 'product', 'plan', 'country'],
  },
  application_declined: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.email],
    vars: ['fullName', 'reference', 'kind', 'product', 'country'],
  },
  application_info_requested: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.email],
    vars: ['fullName', 'reference', 'kind', 'product', 'reason', 'country'],
  },
  order_received: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.email],
    vars: ['fullName', 'reference', 'items', 'total', 'collection', 'country'],
  },
  order_ready: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.email],
    vars: ['fullName', 'reference', 'items', 'total', 'collection', 'country'],
  },
  order_cancelled: {
    category: NotificationCategory.transactional,
    channels: [NotificationChannel.email],
    vars: ['fullName', 'reference', 'items', 'country'],
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
  // Plain text; a blank line starts a new paragraph in the email.
  application_received: {
    email: {
      subject: 'We received your {{kind}} application ({{reference}})',
      body: `Hello {{fullName}},

Thank you for applying with {{country}}. We have your application for the {{product}}.

Reference: {{reference}}
Plan: {{plan}}

Our team reviews applications within one working day. We'll email you as soon as there's a decision, and we may call you if we need anything.

Keep your reference handy if you contact us.`,
    },
  },
  application_approved: {
    email: {
      subject: 'Your application {{reference}} is approved',
      body: `Hello {{fullName}},

Good news: your {{kind}} application for the {{product}} is approved.

Reference: {{reference}}
Plan: {{plan}}

Our team will contact you to arrange collection. When you come, bring the ID you applied with and your reference.`,
    },
  },
  application_declined: {
    email: {
      subject: 'An update on your application {{reference}}',
      body: `Hello {{fullName}},

Thank you for your interest in the {{product}}. After reviewing your {{kind}} application, we're not able to approve it at this time.

Reference: {{reference}}

You're welcome to apply again later, or to buy a device outright with cash. If you have questions, reply to this email or contact {{country}} with your reference.`,
    },
  },
  application_info_requested: {
    email: {
      subject: 'We need a little more information ({{reference}})',
      body: `Hello {{fullName}},

We're reviewing your {{kind}} application for the {{product}} and need one more thing from you:

{{reason}}

Reply to this email or contact {{country}} with your reference ({{reference}}), and we'll pick your application up straight away.`,
    },
  },
  order_received: {
    email: {
      subject: 'We received your order {{reference}}',
      body: `Hello {{fullName}},

Thank you for your order with {{country}}.

Reference: {{reference}}
{{items}}
Total: {{total}}, paid in cash when you collect

{{collection}}

We'll email you again when your order is ready.`,
    },
  },
  order_ready: {
    email: {
      subject: 'Your order {{reference}} is ready',
      body: `Hello {{fullName}},

Your order is ready.

Reference: {{reference}}
{{items}}
Total to pay: {{total}}

{{collection}}

Bring your reference and the ID of the person collecting.`,
    },
  },
  order_cancelled: {
    email: {
      subject: 'Your order {{reference}} was cancelled',
      body: `Hello {{fullName}},

Your order {{reference}} with {{country}} has been cancelled.

{{items}}

Nothing was charged. If this is unexpected, reply to this email or contact us with your reference.`,
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
