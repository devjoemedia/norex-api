import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationEventKey,
  NotificationStatus,
  Prisma,
  PushPlatform,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';
import { keyedHash } from '../../common/crypto/hash.util';
import { ChannelRegistry } from './channels/channel.registry';
import { RenderedMessage } from './channels/channel.interface';
import { assertTemplateVars, renderTemplate, sanitizeHtml } from './template.render';
import {
  ConfigureChannelProviderDto,
  CreateTemplateDto,
  ListNotificationsDto,
  ListTemplatesDto,
  RegisterPushTokenDto,
  TestSendDto,
  UpdatePreferenceDto,
  UpdateTemplateDto,
} from './dto/notifications.dto';
import { DAILY_CAPS, DEFAULT_LOCALE, EVENTS, PLATFORM_DEFAULTS } from './notification.constants';

interface Actor {
  id: string;
  roles: string[];
}

export interface EmitInput {
  tenantId: string;
  eventKey: NotificationEventKey;
  userId?: string;
  entityId?: string; // makes the send idempotent per (event, entity, channel)
  vars: Record<string, string | number | undefined>;
  locale?: string;
  recipient?: { email?: string; phone?: string };
  channels?: NotificationChannel[];
}

const STAFF_TEMPLATE_ROLES = ['product_editor', 'country_manager'];

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly channels: ChannelRegistry,
  ) {}

  private encKey(): string {
    return this.config.get<string>('ENCRYPTION_KEY') ?? this.config.get<string>('JWT_SECRET')!;
  }

  private hashRecipient(v: string): string {
    return keyedHash(this.encKey(), v);
  }

  // ---------------- producer API (called by [02]/[07]/[09]/[06]) ----------------
  async emit(input: EmitInput): Promise<void> {
    const cfg = EVENTS[input.eventKey];
    if (!cfg) throw new BadRequestException('Unknown notification event');
    const locale = input.locale ?? DEFAULT_LOCALE;

    const recipient = { ...input.recipient };
    let fullName: string | undefined;
    if (input.userId) {
      const user = await this.prisma.user.findFirst({
        where: { id: input.userId, tenantId: input.tenantId },
      });
      recipient.phone = recipient.phone ?? user?.phone ?? undefined;
      recipient.email = recipient.email ?? user?.email ?? undefined;
      fullName = user?.fullName ?? undefined;
    }
    const vars = { fullName, ...input.vars };

    for (const channel of input.channels ?? cfg.channels) {
      try {
        await this.dispatchChannel(input, cfg.category, channel, locale, recipient, vars);
      } catch (e) {
        // A notification failure must never break the producing business flow.
        this.logger.warn(`emit ${input.eventKey}/${channel} failed: ${(e as Error).message}`);
      }
    }
  }

  private async dispatchChannel(
    input: EmitInput,
    category: NotificationCategory,
    channel: NotificationChannel,
    locale: string,
    recipient: { email?: string; phone?: string },
    vars: Record<string, string | number | undefined>,
  ): Promise<void> {
    // Resolve the concrete recipient address for this channel.
    const to = await this.recipientFor(input.tenantId, input.userId, channel, recipient);
    if (!to) return; // recipient has no capability on this channel

    // Marketing honours opt-out; transactional is always sent.
    if (category === NotificationCategory.marketing && input.userId) {
      const pref = await this.prisma.notificationPreference.findFirst({
        where: { tenantId: input.tenantId, userId: input.userId, channel, category },
      });
      if (pref && !pref.optedIn) return;
    }

    const recipientHash = this.hashRecipient(to.address);
    const idempotencyKey = input.entityId
      ? `${input.eventKey}:${input.entityId}:${channel}`
      : undefined;

    // Per-recipient daily cap: excess is suppressed and logged, not dropped.
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const sentToday = await this.prisma.notification.count({
      where: { tenantId: input.tenantId, recipientHash, category, createdAt: { gte: since } },
    });

    let notification;
    try {
      notification = await this.prisma.notification.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          eventKey: input.eventKey,
          channel,
          category,
          recipientHash,
          locale,
          idempotencyKey,
          status:
            sentToday >= DAILY_CAPS[category]
              ? NotificationStatus.suppressed
              : NotificationStatus.queued,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return; // duplicate
      throw e;
    }
    if (notification.status === NotificationStatus.suppressed) {
      this.logger.log(`suppressed ${input.eventKey}/${channel} (daily cap)`);
      return;
    }

    // Resolve template, then render fail-closed.
    const tpl = await this.resolveTemplate(input.tenantId, input.eventKey, channel, locale);
    if (!tpl) {
      await this.fail(notification.id, 'no_template');
      return;
    }
    let message: RenderedMessage;
    try {
      const allow = EVENTS[input.eventKey].vars;
      message = {
        subject: tpl.subject ? renderTemplate(tpl.subject, vars, allow) : undefined,
        body: renderTemplate(tpl.body, vars, allow),
      };
    } catch {
      await this.fail(notification.id, 'render_error');
      return;
    }

    try {
      const result = await this.channels.get(channel).send(to.address, message);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.sent,
          provider: channel,
          providerMessageId: result.providerMessageId,
          templateId: tpl.id,
          attempts: 1,
          sentAt: new Date(),
        },
      });
    } catch (e) {
      // TODO: enqueue for retry with back-off; exhausted -> dead-letter (BullMQ, docs/10).
      await this.fail(notification.id, (e as Error).message.slice(0, 60));
    }
  }

  private fail(id: string, errorCode: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { status: NotificationStatus.failed, errorCode, attempts: { increment: 1 } },
    });
  }

  private async recipientFor(
    tenantId: string,
    userId: string | undefined,
    channel: NotificationChannel,
    recipient: { email?: string; phone?: string },
  ): Promise<{ address: string } | null> {
    if (channel === NotificationChannel.email) {
      return recipient.email ? { address: recipient.email } : null;
    }
    if (channel === NotificationChannel.sms || channel === NotificationChannel.whatsapp) {
      return recipient.phone ? { address: recipient.phone } : null;
    }
    if (channel === NotificationChannel.push && userId) {
      const token = await this.prisma.pushToken.findFirst({
        where: { tenantId, userId, revokedAt: null },
        orderBy: { lastSeenAt: 'desc' },
      });
      if (!token) return null;
      return { address: decryptSecret(token.tokenCipher, this.encKey()) };
    }
    return null;
  }

  // tenant (event,channel,locale) -> tenant (event,channel,default) -> platform default
  private async resolveTemplate(
    tenantId: string,
    eventKey: NotificationEventKey,
    channel: NotificationChannel,
    locale: string,
  ): Promise<{ id?: string; subject?: string; body: string } | null> {
    for (const loc of [locale, DEFAULT_LOCALE]) {
      const tpl = await this.prisma.notificationTemplate.findFirst({
        where: { tenantId, eventKey, channel, locale: loc, isActive: true },
        orderBy: { version: 'desc' },
      });
      if (tpl) return { id: tpl.id, subject: tpl.subject ?? undefined, body: tpl.body };
    }
    const fallback = PLATFORM_DEFAULTS[eventKey]?.[channel];
    return fallback ? { subject: fallback.subject, body: fallback.body } : null;
  }

  // ---------------- preferences (self) ----------------
  getPreferences(tenantId: string, userId: string) {
    return this.prisma.notificationPreference.findMany({ where: { tenantId, userId } });
  }

  async updatePreference(tenantId: string, userId: string, dto: UpdatePreferenceDto) {
    if (dto.category === NotificationCategory.transactional) {
      throw new BadRequestException('Transactional messages cannot be turned off');
    }
    return this.prisma.notificationPreference.upsert({
      where: {
        tenantId_userId_channel_category: {
          tenantId,
          userId,
          channel: dto.channel,
          category: dto.category,
        },
      },
      update: { optedIn: dto.optedIn },
      create: {
        tenantId,
        userId,
        channel: dto.channel,
        category: dto.category,
        optedIn: dto.optedIn,
      },
    });
  }

  // ---------------- push tokens (self) ----------------
  async registerPushToken(tenantId: string, userId: string, dto: RegisterPushTokenDto) {
    const tokenHash = this.hashRecipient(dto.token);
    const tokenCipher = encryptSecret(dto.token, this.encKey());
    const token = await this.prisma.pushToken.upsert({
      where: { tenantId_tokenHash: { tenantId, tokenHash } },
      update: { userId, deviceId: dto.deviceId, lastSeenAt: new Date(), revokedAt: null },
      create: {
        tenantId,
        userId,
        platform: dto.platform as PushPlatform,
        tokenCipher,
        tokenHash,
        deviceId: dto.deviceId,
      },
    });
    return { id: token.id, platform: token.platform, deviceId: token.deviceId };
  }

  async revokePushToken(tenantId: string, userId: string, id: string) {
    const token = await this.prisma.pushToken.findFirst({ where: { id, tenantId } });
    if (!token) throw new NotFoundException('Push token not found');
    if (token.userId !== userId) throw new ForbiddenException('Not your device token');
    await this.prisma.pushToken.update({ where: { id }, data: { revokedAt: new Date() } });
    return { revoked: true };
  }

  // ---------------- admin: templates ----------------
  /** Events, their channels and variables, and the built-in text used when a
   * country has no template of its own (the portal's Template Manager). */
  catalog() {
    return (Object.keys(EVENTS) as NotificationEventKey[]).map((eventKey) => ({
      eventKey,
      category: EVENTS[eventKey].category,
      channels: EVENTS[eventKey].channels,
      vars: EVENTS[eventKey].vars,
      defaults: PLATFORM_DEFAULTS[eventKey] ?? {},
    }));
  }

  listTemplates(tenantId: string, q: ListTemplatesDto) {
    return this.prisma.notificationTemplate.findMany({
      where: { tenantId, eventKey: q.eventKey, channel: q.channel, locale: q.locale },
      orderBy: [{ eventKey: 'asc' }, { channel: 'asc' }, { version: 'desc' }],
    });
  }

  async createTemplate(tenantId: string, actor: Actor, dto: CreateTemplateDto) {
    this.validateBody(dto.eventKey, dto.channel, dto.body, dto.subject);
    return this.prisma.$transaction(async (tx) => {
      await tx.notificationTemplate.updateMany({
        where: {
          tenantId,
          eventKey: dto.eventKey,
          channel: dto.channel,
          locale: dto.locale,
          isActive: true,
        },
        data: { isActive: false },
      });
      const version = await this.nextVersion(tx, tenantId, dto.eventKey, dto.channel, dto.locale);
      const tpl = await tx.notificationTemplate.create({
        data: {
          tenantId,
          eventKey: dto.eventKey,
          channel: dto.channel,
          locale: dto.locale,
          category: EVENTS[dto.eventKey].category,
          subject:
            dto.channel === NotificationChannel.email
              ? this.clean(dto.channel, dto.subject)
              : dto.subject,
          body: this.clean(dto.channel, dto.body)!,
          whatsappTemplateName: dto.whatsappTemplateName,
          version,
          updatedById: actor.id,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'notifications.template.created',
          entity: 'notification_template',
          entityId: tpl.id,
          after: { eventKey: dto.eventKey, channel: dto.channel, locale: dto.locale, version },
        },
      });
      return tpl;
    });
  }

  async updateTemplate(tenantId: string, actor: Actor, id: string, dto: UpdateTemplateDto) {
    const current = await this.prisma.notificationTemplate.findFirst({ where: { id, tenantId } });
    if (!current) throw new NotFoundException('Template not found');
    const body = dto.body ?? current.body;
    const subject = dto.subject ?? current.subject ?? undefined;
    this.validateBody(current.eventKey, current.channel, body, subject);

    return this.prisma.$transaction(async (tx) => {
      await tx.notificationTemplate.updateMany({
        where: {
          tenantId,
          eventKey: current.eventKey,
          channel: current.channel,
          locale: current.locale,
          isActive: true,
        },
        data: { isActive: false },
      });
      const version = await this.nextVersion(
        tx,
        tenantId,
        current.eventKey,
        current.channel,
        current.locale,
      );
      const next = await tx.notificationTemplate.create({
        data: {
          tenantId,
          eventKey: current.eventKey,
          channel: current.channel,
          locale: current.locale,
          category: current.category,
          subject:
            current.channel === NotificationChannel.email
              ? this.clean(current.channel, subject)
              : subject,
          body: this.clean(current.channel, body)!,
          whatsappTemplateName: dto.whatsappTemplateName ?? current.whatsappTemplateName,
          version,
          isActive: dto.isActive ?? true,
          updatedById: actor.id,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'notifications.template.updated',
          entity: 'notification_template',
          entityId: next.id,
          before: { version: current.version },
          after: { version },
        },
      });
      return next;
    });
  }

  async testSend(tenantId: string, actor: Actor, dto: TestSendDto) {
    const tpl = await this.prisma.notificationTemplate.findFirst({
      where: { id: dto.templateId, tenantId },
    });
    if (!tpl) throw new NotFoundException('Template not found');
    const allow = EVENTS[tpl.eventKey].vars;
    const message: RenderedMessage = {
      subject: tpl.subject ? renderTemplate(tpl.subject, dto.vars ?? {}, allow) : undefined,
      body: renderTemplate(tpl.body, dto.vars ?? {}, allow),
    };
    const result = await this.channels.get(tpl.channel).send(dto.to, message);
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'notifications.template.test_sent',
      entity: 'notification_template',
      entityId: tpl.id,
    });
    return { providerMessageId: result.providerMessageId, preview: message };
  }

  // ---------------- admin: providers + delivery log ----------------
  async configureProvider(tenantId: string, actor: Actor, dto: ConfigureChannelProviderDto) {
    await this.prisma.channelProvider.updateMany({
      where: { tenantId, channel: dto.channel, isPrimary: true },
      data: { isPrimary: false },
    });
    const cfg = await this.prisma.channelProvider.create({
      data: {
        tenantId,
        channel: dto.channel,
        provider: dto.provider,
        senderConfig: dto.senderConfig as Prisma.InputJsonValue,
        secretRef: dto.secretRef,
        isPrimary: true,
      },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'notifications.provider.configured',
      entity: 'channel_provider',
      entityId: cfg.id,
      after: { channel: dto.channel, provider: dto.provider },
    });
    return { id: cfg.id, channel: cfg.channel, provider: cfg.provider, isPrimary: cfg.isPrimary };
  }

  // Delivery log — PII-safe (recipient is only ever a hash).
  listNotifications(tenantId: string, q: ListNotificationsDto) {
    return this.prisma.notification.findMany({
      where: { tenantId, status: q.status, eventKey: q.eventKey, channel: q.channel },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        eventKey: true,
        channel: true,
        category: true,
        status: true,
        provider: true,
        providerMessageId: true,
        attempts: true,
        errorCode: true,
        recipientHash: true,
        createdAt: true,
        sentAt: true,
        deliveredAt: true,
      },
    });
  }

  // ---------------- provider delivery webhook ----------------
  async handleWebhook(tenantId: string, provider: string, rawBody: string, signature?: string) {
    // Verify HMAC over the raw body before mutating any status (docs/10).
    if (!this.verify(rawBody, signature))
      throw new UnauthorizedException('Invalid webhook signature');
    let payload: { providerMessageId?: string; status?: string };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException('Malformed webhook body');
    }
    const { providerMessageId, status } = payload;
    if (!providerMessageId || (status !== 'delivered' && status !== 'failed')) {
      throw new BadRequestException('Unsupported delivery status');
    }
    // Match on the provider message id within the tenant; the route's :provider is used
    // for signature routing, not row matching.
    void provider;
    const notification = await this.prisma.notification.findFirst({
      where: { tenantId, providerMessageId },
    });
    if (!notification) return { status: 'unknown' };
    // Only advance from sent — never fabricate a delivered from nothing, and replayed
    // callbacks are inert once the terminal state is set.
    if (notification.status !== NotificationStatus.sent) return { status: 'ignored' };
    await this.prisma.notification.update({
      where: { id: notification.id },
      data:
        status === 'delivered'
          ? { status: NotificationStatus.delivered, deliveredAt: new Date() }
          : { status: NotificationStatus.failed, errorCode: 'provider_failed' },
    });
    return { status };
  }

  private verify(rawBody: string, signature?: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.encKey()).update(rawBody).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---------------- helpers ----------------
  private clean(channel: NotificationChannel, value?: string): string | undefined {
    if (value === undefined) return undefined;
    return channel === NotificationChannel.email ? sanitizeHtml(value) : value;
  }

  private validateBody(
    eventKey: NotificationEventKey,
    channel: NotificationChannel,
    body: string,
    subject?: string,
  ): void {
    const allow = EVENTS[eventKey].vars;
    assertTemplateVars(body, allow);
    if (subject) assertTemplateVars(subject, allow);
    void channel;
  }

  private async nextVersion(
    tx: Prisma.TransactionClient,
    tenantId: string,
    eventKey: NotificationEventKey,
    channel: NotificationChannel,
    locale: string,
  ): Promise<number> {
    const top = await tx.notificationTemplate.findFirst({
      where: { tenantId, eventKey, channel, locale },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return (top?.version ?? 0) + 1;
  }

  isTemplateStaff(roles: string[]): boolean {
    return roles.some((r) => STAFF_TEMPLATE_ROLES.includes(r));
  }

  // For sandbox/webhook tooling and tests.
  sign(rawBody: string): string {
    return createHmac('sha256', this.encKey()).update(rawBody).digest('hex');
  }
}
