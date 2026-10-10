import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { jobRuns } from '../../common/jobs/job-status';

const DAY = 86_400_000;

// What's connected and whether it's working (docs/26): email, SMS/WhatsApp, payment
// providers and their webhooks, and the background jobs. Facts only: no secrets.
@Injectable()
export class SystemHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Platform-wide settings (the same for every country). */
  platform() {
    return {
      email: {
        configured: !!this.config.get<string>('RESEND_API_KEY'),
        from: this.config.get<string>('EMAIL_FROM') ?? null,
        replyTo: this.config.get<string>('EMAIL_REPLY_TO') ?? null,
      },
      portalUrl: this.config.get<string>('PORTAL_URL') ?? null,
      webIntake: !!this.config.get<string>('WEB_INTAKE_KEY'),
      jobs: jobRuns(),
      startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    };
  }

  /** One country's providers and the last 24 hours of deliveries and webhooks. */
  async country(tenantId: string) {
    const since = new Date(Date.now() - DAY);
    const [channels, payments, notifications, failures, webhooks] = await Promise.all([
      this.prisma.channelProvider.findMany({
        where: { tenantId, isActive: true },
        select: { channel: true, provider: true },
      }),
      this.prisma.providerConfig.findMany({
        where: { tenantId, active: true },
        select: { provider: true },
      }),
      this.prisma.notification.groupBy({
        by: ['channel', 'status'],
        where: { tenantId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.notification.groupBy({
        by: ['channel', 'errorCode'],
        where: { tenantId, createdAt: { gte: since }, status: 'failed' },
        _count: { _all: true },
        orderBy: { _count: { errorCode: 'desc' } },
        take: 5,
      }),
      this.prisma.webhookEvent.groupBy({
        by: ['provider', 'result'],
        where: { tenantId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    return {
      channels: channels.map((c) => ({ channel: c.channel, provider: c.provider })),
      paymentProviders: payments.map((p) => p.provider),
      notifications: notifications.map((n) => ({
        channel: n.channel,
        status: n.status,
        count: n._count._all,
      })),
      topFailures: failures.map((f) => ({
        channel: f.channel,
        error: f.errorCode ?? 'unknown',
        count: f._count._all,
      })),
      webhooks: webhooks.map((w) => ({
        provider: w.provider,
        result: w.result ?? 'pending',
        count: w._count._all,
      })),
    };
  }
}
