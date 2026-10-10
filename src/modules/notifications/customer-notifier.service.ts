import { Injectable, Logger } from '@nestjs/common';
import { ApplicationStatus, ApplicationType, NotificationEventKey } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { formatAmount } from '../../common/tenancy/money-text';
import { NotificationsService } from './notifications.service';

// Customer emails about applications and buy now orders (docs/10). Each method
// gathers the details for one event and hands them to NotificationsService, which
// picks the country's template (or the platform default), logs delivery and dedupes.
// Best-effort: nothing here ever throws into the business flow that called it.

const KIND: Record<ApplicationType, string> = {
  financing: 'installment plan',
  lease: 'lease',
  trade_in: 'trade-in',
};

const DECISION_EVENT: Partial<Record<ApplicationStatus, NotificationEventKey>> = {
  approved: 'application_approved',
  declined: 'application_declined',
  info_requested: 'application_info_requested',
};

interface PlanSnapshot {
  months?: number;
  monthlyMinor?: number;
  depositMinor?: number;
  currency?: string;
  frequency?: 'monthly' | 'biweekly' | 'weekly';
  periods?: number;
  periodMinor?: number;
}

const EVERY: Record<string, string> = { weekly: 'weekly', biweekly: 'fortnightly' };

@Injectable()
export class CustomerNotifier {
  private readonly logger = new Logger('CustomerNotifier');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** After an application is saved (website, app or portal). */
  async applicationReceived(tenantId: string, applicationId: string, email?: string | null) {
    await this.safely('application_received', () =>
      this.sendForApplication(tenantId, applicationId, 'application_received', {
        email,
        entityId: applicationId,
      }),
    );
  }

  /**
   * After a decision. `occurrence` keeps repeated decisions of the same kind (a second
   * "more info needed") from being deduped as one message.
   */
  async applicationDecided(
    tenantId: string,
    applicationId: string,
    status: ApplicationStatus,
    opts: { reason?: string | null; occurrence: string },
  ) {
    const event = DECISION_EVENT[status];
    if (!event) return;
    await this.safely(event, () =>
      this.sendForApplication(tenantId, applicationId, event, {
        reason: opts.reason ?? undefined,
        entityId: `${applicationId}:${status}:${opts.occurrence}`,
      }),
    );
  }

  async orderReceived(tenantId: string, orderId: string, email?: string | null) {
    await this.safely('order_received', () =>
      this.sendForOrder(tenantId, orderId, 'order_received', email),
    );
  }

  async orderReady(tenantId: string, orderId: string) {
    await this.safely('order_ready', () => this.sendForOrder(tenantId, orderId, 'order_ready'));
  }

  async orderCancelled(tenantId: string, orderId: string) {
    await this.safely('order_cancelled', () =>
      this.sendForOrder(tenantId, orderId, 'order_cancelled'),
    );
  }

  // ---------- internals ----------

  private async safely(what: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`${what} not sent: ${(e as Error).message}`);
    }
  }

  private async sendForApplication(
    tenantId: string,
    applicationId: string,
    eventKey: NotificationEventKey,
    opts: { email?: string | null; reason?: string; entityId: string },
  ) {
    const app = await this.prisma.application.findFirst({
      where: { id: applicationId, tenantId },
    });
    if (!app) return;
    const [tenant, customer, device, variant] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.user.findFirst({ where: { id: app.customerId, tenantId } }),
      app.deviceId ? this.prisma.device.findFirst({ where: { id: app.deviceId, tenantId } }) : null,
      app.variantId
        ? this.prisma.deviceVariant.findFirst({ where: { id: app.variantId, tenantId } })
        : null,
    ]);
    const to = opts.email?.trim() || customer?.email;
    if (!to) return; // phone-only applicant: nothing to email yet

    const product = [device?.name ?? 'device', variant?.storage].filter(Boolean).join(' ');
    await this.notifications.emit({
      tenantId,
      eventKey,
      userId: app.customerId,
      entityId: opts.entityId,
      locale: tenant?.locale,
      recipient: { email: to },
      vars: {
        fullName: firstName(customer?.fullName),
        reference: app.reference ?? '',
        kind: KIND[app.type],
        product,
        plan: planText(app.type, app.planSnapshot as PlanSnapshot | null, app.currency, {
          financeMonths: app.financeMonths,
          leaseMonths: app.leaseMonths,
        }),
        reason: opts.reason,
        country: tenant?.name ?? 'Norex',
      },
    });
  }

  private async sendForOrder(
    tenantId: string,
    orderId: string,
    eventKey: NotificationEventKey,
    email?: string | null,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) return;
    const [tenant, customer, branch] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.user.findFirst({ where: { id: order.customerId, tenantId } }),
      order.branchId
        ? this.prisma.branch.findFirst({ where: { id: order.branchId, tenantId } })
        : null,
    ]);
    const to = email?.trim() || customer?.email;
    if (!to) return;

    const items = order.items
      .map((i) => {
        const name = [i.name, i.storage, i.color].filter(Boolean).join(' ');
        return `${i.quantity} × ${name}`;
      })
      .join('\n');
    const where = branch
      ? [branch.name, branch.address ?? branch.city].filter(Boolean).join(', ')
      : (order.preferredBranch ?? null);
    const collection =
      order.fulfilmentMethod === 'delivery'
        ? 'We will deliver to the address you gave. Our team will call you to arrange a time.'
        : where
          ? `Collect at: ${where}.`
          : 'Collect at the Norex outlet you chose. Our team will confirm which one.';

    await this.notifications.emit({
      tenantId,
      eventKey,
      userId: order.customerId,
      entityId: orderId,
      locale: tenant?.locale,
      recipient: { email: to },
      vars: {
        fullName: firstName(customer?.fullName),
        reference: order.reference,
        items,
        total: `${order.currency} ${formatAmount(order.subtotalMinor + order.deliveryFeeMinor, order.currency)}`,
        collection,
        country: tenant?.name ?? 'Norex',
      },
    });
  }
}

function firstName(full?: string | null): string {
  return full?.trim().split(/\s+/)[0] || 'there';
}

/** "6 monthly payments of GMD 6,975.00, after a GMD 2,000.00 deposit" and similar. */
export function planText(
  type: ApplicationType,
  snap: PlanSnapshot | null,
  currency: string | null,
  terms: { financeMonths: number | null; leaseMonths: number | null },
): string {
  const cur = snap?.currency ?? currency ?? '';
  const money = (minor: number) => `${cur} ${formatAmount(minor, cur || 'GMD')}`.trim();
  if (type === ApplicationType.trade_in) return 'Trade-in towards a new device';
  const months =
    snap?.months ?? (type === ApplicationType.lease ? terms.leaseMonths : terms.financeMonths);
  const monthly = snap?.monthlyMinor;
  if (type === ApplicationType.lease) {
    return monthly && months
      ? `${money(monthly)} a month for ${months} months`
      : `Lease${months ? ` for ${months} months` : ''}`;
  }
  const deposit = snap?.depositMinor ? `, after a ${money(snap.depositMinor)} deposit` : '';
  const every = snap?.frequency ? EVERY[snap.frequency] : undefined;
  if (every && snap?.periods && snap.periodMinor) {
    return `${snap.periods} ${every} payments of ${money(snap.periodMinor)}${deposit}`;
  }
  if (monthly && months) {
    return `${months} monthly payments of ${money(monthly)}${deposit}`;
  }
  return months ? `${months} monthly payments` : 'Installment plan';
}
