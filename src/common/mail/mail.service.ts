import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Transactional email through Resend's HTTP API (the website uses the same account).
// Without RESEND_API_KEY nothing is sent and send() returns false, so callers can
// fall back to showing the link to the person who triggered it.
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return !!this.config.get<string>('RESEND_API_KEY');
  }

  async send(message: MailMessage): Promise<boolean> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.log(`RESEND_API_KEY not set; not emailing "${message.subject}"`);
      return false;
    }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.config.get<string>('EMAIL_FROM'),
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // The body names the problem (e.g. an unverified sender domain), never secrets.
        this.logger.warn(`Resend refused "${message.subject}": ${res.status} ${await res.text()}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`Resend unreachable for "${message.subject}": ${(e as Error).message}`);
      return false;
    }
  }
}

/** Escapes text for an HTML email body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
