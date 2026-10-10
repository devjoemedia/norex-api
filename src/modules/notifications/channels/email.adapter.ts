import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { MailService, escapeHtml } from '../../../common/mail/mail.service';
import { sanitizeHtml } from '../template.render';
import { ChannelAdapter, RenderedMessage, SendResult } from './channel.interface';

// Email through Resend (MailService). A failure throws, so the delivery log shows the
// message as failed rather than pretending it went (docs/10).
@Injectable()
export class EmailAdapter implements ChannelAdapter {
  readonly channel = NotificationChannel.email;

  constructor(private readonly mail: MailService) {}

  async send(to: string, message: RenderedMessage): Promise<SendResult> {
    if (!this.mail.configured) throw new Error('email_not_configured');
    const { html, text } = emailBodies(message.body);
    const ok = await this.mail.send({
      to,
      subject: message.subject ?? 'A message from Norex',
      text,
      html: emailLayout(html),
    });
    if (!ok) throw new Error('email_provider_refused');
    // Resend's id isn't needed downstream; the log keeps the attempt.
    return { providerMessageId: `resend_${Date.now()}` };
  }
}

const LOOKS_LIKE_HTML = /<\s*(p|br|div|a|strong|em|ul|ol|li|table|h[1-6])\b/i;

/**
 * Templates are plain text (a blank line = new paragraph) or, if a country wrote
 * HTML in the Template manager, sanitized HTML. Returns both parts of the email.
 */
export function emailBodies(body: string): { html: string; text: string } {
  if (LOOKS_LIKE_HTML.test(body)) {
    const html = sanitizeHtml(body);
    const text = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { html, text };
  }
  const html = body
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return { html, text: body.trim() };
}

function emailLayout(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f4f5f4;padding:24px 12px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111827">
<div style="font-weight:800;font-size:18px;color:#15803d;margin-bottom:18px">Norex</div>
${inner}
</div>
<p style="max-width:560px;margin:12px auto 0;font-family:system-ui,sans-serif;font-size:12px;color:#6b7280;text-align:center">You're receiving this because you applied or ordered with Norex.</p>
</body></html>`;
}
