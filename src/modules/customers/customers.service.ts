import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ImeiService } from '../device-units/imei.service';
import { isValidImei, normalizeImei } from '../device-units/imei.util';
import { SearchKind } from './search-access';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  status?: string;
}

const PER_KIND = 5;

// Global search (portal topbar) and the customer 360° view.
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imei: ImeiService,
  ) {}

  /**
   * One country's matches for `q`: references (BNP-/LSE-/TRD-/ORD-), phone numbers,
   * names and emails, and IMEIs (full number or last 4) / serials. Only the kinds the
   * caller may open are searched.
   */
  async search(tenantId: string, q: string, kinds: Set<SearchKind>): Promise<SearchHit[]> {
    const term = q.trim();
    if (term.length < 2 || kinds.size === 0) return [];
    const upper = term.toUpperCase();
    const digits = term.replace(/\D/g, '');
    const phoneLike = digits.length >= 5 && digits.length === term.replace(/[\s+()-]/g, '').length;
    const hits: SearchHit[] = [];

    // Customers (and the people behind applications/orders) by phone, name or email.
    const peopleWhere: Prisma.UserWhereInput = {
      tenantId,
      OR: [
        ...(phoneLike ? [{ phone: { contains: digits } }] : []),
        { fullName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ],
    };
    const people =
      kinds.has('customer') || kinds.has('staff')
        ? await this.prisma.user.findMany({
            where: peopleWhere,
            include: { roles: true },
            take: 20,
            orderBy: { createdAt: 'desc' },
          })
        : [];
    const customerIds = people.filter((p) => !p.isStaff).map((p) => p.id);

    if (kinds.has('application')) {
      const apps = await this.prisma.application.findMany({
        where: {
          tenantId,
          OR: [
            { reference: { contains: upper } },
            ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: PER_KIND,
      });
      const names = await this.names(
        tenantId,
        apps.map((a) => a.customerId),
      );
      for (const a of apps) {
        hits.push({
          kind: 'application',
          id: a.id,
          title: a.reference ?? a.id.slice(0, 8),
          subtitle: `${names.get(a.customerId) ?? 'Customer'} · ${a.type.replace('_', '-')}`,
          status: a.status,
        });
      }
    }

    if (kinds.has('order')) {
      const orders = await this.prisma.order.findMany({
        where: {
          tenantId,
          OR: [
            { reference: { contains: upper } },
            ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: PER_KIND,
      });
      const names = await this.names(
        tenantId,
        orders.map((o) => o.customerId),
      );
      for (const o of orders) {
        hits.push({
          kind: 'order',
          id: o.id,
          title: o.reference,
          subtitle: `${names.get(o.customerId) ?? 'Customer'} · buy now order`,
          status: o.status,
        });
      }
    }

    if (kinds.has('customer')) {
      for (const p of people.filter((u) => !u.isStaff).slice(0, PER_KIND)) {
        hits.push({
          kind: 'customer',
          id: p.id,
          title: p.fullName ?? p.phone ?? 'Customer',
          subtitle: [p.phone, p.email].filter(Boolean).join(' · '),
          status: p.status,
        });
      }
    }

    if (kinds.has('staff')) {
      for (const p of people.filter((u) => u.isStaff).slice(0, PER_KIND)) {
        hits.push({
          kind: 'staff',
          id: p.id,
          title: p.fullName ?? p.email ?? 'Staff',
          subtitle: [p.email, p.roles.map((r) => r.role.replace('_', ' ')).join(', ')]
            .filter(Boolean)
            .join(' · '),
          status: p.status,
        });
      }
    }

    if (kinds.has('device')) {
      const imeiDigits = normalizeImei(term);
      const where: Prisma.DeviceUnitWhereInput | null = isValidImei(imeiDigits)
        ? { tenantId, imeiHash: this.imei.hash(tenantId, imeiDigits) }
        : /^\d{4}$/.test(imeiDigits)
          ? { tenantId, imeiLast4: imeiDigits }
          : term.length >= 4
            ? { tenantId, serial: { contains: term, mode: 'insensitive' } }
            : null;
      if (where) {
        const units = await this.prisma.deviceUnit.findMany({ where, take: PER_KIND });
        const models = await this.prisma.device.findMany({
          where: { tenantId, id: { in: units.map((u) => u.deviceId) } },
          select: { id: true, name: true },
        });
        const model = new Map(models.map((m) => [m.id, m.name]));
        for (const u of units) {
          hits.push({
            kind: 'device',
            id: u.id,
            title: `${model.get(u.deviceId) ?? 'Device'} ••••${u.imeiLast4}`,
            subtitle: u.serial ? `Serial ${u.serial}` : 'IMEI match',
            status: u.status,
          });
        }
      }
    }
    return hits;
  }

  /** Everything about one customer, for staff (support, compliance, agents). */
  async detail(tenantId: string, id: string) {
    const user = await this.prisma.user.findFirst({ where: { tenantId, id, isStaff: false } });
    if (!user) throw new NotFoundException('Customer not found');
    const [tenant, kyc, apps, orders, units, schedules, payments, messages] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.kycProfile.findFirst({ where: { tenantId, customerId: id } }),
      this.prisma.application.findMany({
        where: { tenantId, customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.order.findMany({
        where: { tenantId, customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.deviceUnit.findMany({ where: { tenantId, customerId: id }, take: 20 }),
      this.prisma.repaymentSchedule.findMany({
        where: { tenantId, customerId: id },
        include: { installments: { orderBy: { seq: 'asc' } } },
      }),
      this.prisma.payment.findMany({
        where: { tenantId, customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.notification.findMany({
        where: { tenantId, userId: id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);
    const deviceIds = [
      ...new Set([...apps.map((a) => a.deviceId), ...units.map((u) => u.deviceId)]),
    ];
    const devices = await this.prisma.device.findMany({
      where: { tenantId, id: { in: deviceIds } },
      select: { id: true, name: true },
    });
    const model = new Map(devices.map((d) => [d.id, d.name]));
    const now = Date.now();

    return {
      id: user.id,
      name: user.fullName ?? '—',
      phone: user.phone,
      email: user.email,
      status: user.status,
      since: user.createdAt.toISOString(),
      currency: tenant?.currency ?? null,
      country: tenant?.name ?? null,
      kyc: kyc
        ? {
            id: kyc.id,
            status: kyc.status,
            idType: kyc.idTypeCode ?? tenant?.idType ?? null,
            idLast4: kyc.idNumberLast4,
            reviewedAt: kyc.reviewedAt?.toISOString() ?? null,
          }
        : null,
      applications: apps.map((a) => ({
        id: a.id,
        reference: a.reference,
        type: a.type,
        status: a.status,
        device: model.get(a.deviceId) ?? null,
        amountMinor: a.amountMinor,
        currency: a.currency,
        channel: a.channel,
        createdAt: a.createdAt.toISOString(),
      })),
      orders: orders.map((o) => ({
        id: o.id,
        reference: o.reference,
        status: o.status,
        paymentStatus: o.paymentStatus,
        totalMinor: o.subtotalMinor,
        currency: o.currency,
        createdAt: o.createdAt.toISOString(),
      })),
      devices: units.map((u) => ({
        id: u.id,
        model: model.get(u.deviceId) ?? null,
        imeiLast4: u.imeiLast4,
        status: u.status,
        lockState: u.lockState,
      })),
      schedules: schedules.map((s) => {
        const open = s.installments.filter((i) => i.status !== 'paid');
        const next = open.find((i) => i.dueDate.getTime() >= now) ?? open[0] ?? null;
        const overdue = open.filter((i) => i.dueDate.getTime() < now);
        return {
          id: s.id,
          applicationId: s.applicationId,
          kind: s.kind,
          status: s.status,
          currency: s.currency,
          totalMinor: s.totalAmountMinor,
          paidMinor: s.installments.reduce((n, i) => n + i.paidAmountMinor, 0),
          nextDue: next
            ? {
                dueDate: next.dueDate.toISOString(),
                amountMinor: next.amountMinor - next.paidAmountMinor,
              }
            : null,
          overdueMinor: overdue.reduce((n, i) => n + i.amountMinor - i.paidAmountMinor, 0),
          overdueCount: overdue.length,
        };
      }),
      payments: payments.map((p) => ({
        id: p.id,
        purpose: p.purpose,
        status: p.status,
        provider: p.provider,
        amountMinor: p.amountMinor,
        currency: p.currency,
        createdAt: p.createdAt.toISOString(),
      })),
      messages: messages.map((m) => ({
        id: m.id,
        event: m.eventKey,
        channel: m.channel,
        status: m.status,
        error: m.errorCode,
        at: (m.sentAt ?? m.createdAt).toISOString(),
      })),
    };
  }

  private async names(tenantId: string, ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { tenantId, id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true, phone: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName ?? u.phone ?? 'Customer']));
  }
}
