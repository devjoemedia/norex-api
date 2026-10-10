import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { keyedHash, randomTokenHex } from '../../common/crypto/hash.util';
import { MailService, escapeHtml } from '../../common/mail/mail.service';
import { parseOrigins } from '../../common/http/cors';

// Staff invites (docs/20): instead of a password chosen by someone else, a new or
// reset staff member gets a single-use link. Opening it, they choose their own
// password and set up two-factor. Only a keyed hash of the token is stored.
export const INVITE_TTL_HOURS = 72;

export interface InviteResult {
  /** The link, so the inviter can share it if email isn't set up or doesn't arrive. */
  url: string;
  expiresAt: string;
  /** True when the invite email was accepted by the mail provider. */
  emailed: boolean;
}

@Injectable()
export class StaffInviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  private pepper(): string {
    return this.config.get<string>('JWT_SECRET')!;
  }

  private portalUrl(): string {
    const explicit = this.config.get<string>('PORTAL_URL');
    if (explicit) return explicit.replace(/\/+$/, '');
    const origins = parseOrigins(this.config.get<string>('CORS_ORIGINS'));
    const https = origins.find((o) => o.startsWith('https://') && !o.includes('*'));
    return https ?? origins.find((o) => !o.includes('*')) ?? 'http://localhost:3100';
  }

  /**
   * Issues a fresh invite: the old password, two-factor, recovery codes, sessions
   * and any earlier invite stop working. Call it inside the user's tenant scope.
   */
  async invite(
    tenantId: string,
    user: { id: string; email: string; fullName: string | null },
    opts: { invitedBy?: string | null; reason: 'new' | 'reset' },
  ): Promise<InviteResult> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Country not found');

    const token = randomTokenHex(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: null, totpSecret: null, totpEnabledAt: null },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.staffChallenge.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      }),
      this.prisma.staffChallenge.create({
        data: {
          tenantId,
          userId: user.id,
          purpose: 'invite',
          tokenHash: keyedHash(this.pepper(), token),
          expiresAt,
        },
      }),
    ]);

    const params = new URLSearchParams({ tenant: tenant.subdomain, token });
    const url = `${this.portalUrl()}/accept-invite?${params.toString()}`;
    const place = tenant.isCountry ? tenant.name : 'Norex HQ';
    const emailed = await this.mail.send(
      inviteEmail({
        to: user.email,
        name: user.fullName,
        invitedBy: opts.invitedBy ?? null,
        place,
        url,
        reason: opts.reason,
      }),
    );
    return { url, expiresAt: expiresAt.toISOString(), emailed };
  }

  /** The live invite for a token, or an error saying why it can't be used. */
  async find(tenantId: string, token: string) {
    const invite = await this.prisma.staffChallenge.findFirst({
      where: { tenantId, purpose: 'invite', tokenHash: keyedHash(this.pepper(), token) },
      include: { user: true },
    });
    if (!invite) throw new NotFoundException('This invite link is not valid');
    if (invite.consumedAt) {
      throw new GoneException('This invite has already been used or replaced by a newer one');
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new GoneException('This invite has expired');
    }
    if (invite.user.status === 'suspended') throw new GoneException('This account is suspended');
    return invite;
  }
}

function inviteEmail(input: {
  to: string;
  name: string | null;
  invitedBy: string | null;
  place: string;
  url: string;
  reason: 'new' | 'reset';
}) {
  const hello = input.name ? `Hi ${input.name},` : 'Hi,';
  const lead =
    input.reason === 'reset'
      ? `Your sign-in to the Norex admin portal (${input.place}) was reset.`
      : `${input.invitedBy ?? 'Norex'} added you to the Norex admin portal (${input.place}).`;
  const steps =
    'Open the link, choose your password, then set up two-factor sign-in with an authenticator app on your phone.';
  const expiry = `The link works once and expires in ${INVITE_TTL_HOURS} hours. If it has expired, ask for a new one.`;
  const text = [
    hello,
    '',
    lead,
    steps,
    '',
    input.url,
    '',
    expiry,
    "If you weren't expecting this, ignore this email.",
  ].join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111827;max-width:520px">
<p>${escapeHtml(hello)}</p>
<p>${escapeHtml(lead)} ${escapeHtml(steps)}</p>
<p><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#15803d;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Set up your sign-in</a></p>
<p style="color:#6b7280;font-size:13px">${escapeHtml(expiry)} If you weren't expecting this, ignore this email.</p>
</div>`;
  return {
    to: input.to,
    subject:
      input.reason === 'reset'
        ? 'Your Norex sign-in was reset'
        : "You're invited to the Norex admin portal",
    text,
    html,
  };
}
