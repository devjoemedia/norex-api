import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationStatus,
  DeviceUnitStatus,
  FulfilmentStatus,
  OrderPaymentStatus,
  OrderStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { formatAmount } from '../../common/tenancy/money-text';
import { ApplicationsService } from '../applications/applications.service';
import { PaymentsService } from '../payments/payments.service';
import { periodsFor } from '../payments/repayment-frequency';
import { isValidImei, normalizeImei } from '../device-units/imei.util';
import { ImeiService } from '../device-units/imei.service';
import { agreementText } from './agreement-text';
import { PayoutsService } from '../payouts/payouts.service';

export interface Actor {
  id: string;
  roles: string[];
}

const PICKABLE: ApplicationStatus[] = [
  ApplicationStatus.approved,
  ApplicationStatus.agreement_pending,
];
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SIGNATURE_BYTES = 300_000;
const PNG = [0x89, 0x50, 0x4e, 0x47];

// The in-store sale at an outlet (docs/21): find the customer, take a phone from the
// outlet's stock by IMEI, get the agreement signed on screen, take the deposit and
// hand over. Also cash sales and repayments taken at the counter.
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
    private readonly payments: PaymentsService,
    private readonly imei: ImeiService,
    private readonly payouts: PayoutsService,
  ) {}

  /** Agents sell from their own outlet; managers pick one. */
  async outletFor(tenantId: string, actor: Actor, requested?: string | null): Promise<string> {
    if (actor.roles.includes(Role.agent)) {
      const role = await this.prisma.userRole.findFirst({
        where: { tenantId, userId: actor.id, role: Role.agent },
      });
      if (!role?.branchId) throw new ForbiddenException('You are not assigned to an outlet');
      if (requested && requested !== role.branchId) {
        throw new ForbiddenException('You can only sell from your own outlet');
      }
      return role.branchId;
    }
    if (!requested) throw new BadRequestException('Choose the outlet you are selling from');
    const branch = await this.prisma.branch.findFirst({ where: { tenantId, id: requested } });
    if (!branch) throw new NotFoundException('Outlet not found');
    return branch.id;
  }

  // ---------- lookup ----------

  /** Customers by phone, name or reference, with what they can collect or pay. */
  async lookup(tenantId: string, q: string) {
    const term = q.trim();
    if (term.length < 3) return [];
    const upper = term.toUpperCase();
    const digits = term.replace(/\D/g, '');
    const byRef = /^(BNP|LSE|TRD)-/.test(upper)
      ? await this.prisma.application.findMany({
          where: { tenantId, reference: { contains: upper } },
          select: { customerId: true },
          take: 5,
        })
      : [];
    const people = await this.prisma.user.findMany({
      where: {
        tenantId,
        isStaff: false,
        OR: [
          ...(byRef.length ? [{ id: { in: byRef.map((a) => a.customerId) } }] : []),
          ...(digits.length >= 5 ? [{ phone: { contains: digits } }] : []),
          ...(digits.length < 5
            ? [{ fullName: { contains: term, mode: 'insensitive' as const } }]
            : []),
        ],
      },
      take: 5,
    });
    return Promise.all(people.map((p) => this.customerCard(tenantId, p.id)));
  }

  async customerCard(tenantId: string, customerId: string) {
    const [user, kyc, apps, schedules] = await Promise.all([
      this.prisma.user.findFirstOrThrow({ where: { tenantId, id: customerId } }),
      this.prisma.kycProfile.findFirst({ where: { tenantId, customerId } }),
      this.prisma.application.findMany({
        where: { tenantId, customerId, status: { in: PICKABLE } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.repaymentSchedule.findMany({
        where: { tenantId, customerId, status: 'active' },
        include: { installments: { orderBy: { seq: 'asc' } } },
      }),
    ]);
    const scheduleApps = await this.prisma.application.findMany({
      where: { tenantId, id: { in: schedules.map((s) => s.applicationId) } },
      select: { id: true, reference: true, deviceId: true },
    });
    const devices = await this.prisma.device.findMany({
      where: {
        tenantId,
        id: { in: [...apps.map((a) => a.deviceId), ...scheduleApps.map((a) => a.deviceId)] },
      },
      select: { id: true, name: true },
    });
    const variants = await this.prisma.deviceVariant.findMany({
      where: { tenantId, id: { in: apps.map((a) => a.variantId).filter((v): v is string => !!v) } },
      select: { id: true, storage: true },
    });
    const deviceName = new Map(devices.map((d) => [d.id, d.name]));
    const storage = new Map(variants.map((v) => [v.id, v.storage]));
    const appRef = new Map(scheduleApps.map((a) => [a.id, a]));
    const now = Date.now();

    return {
      id: user.id,
      name: user.fullName ?? 'Customer',
      phone: user.phone,
      email: user.email,
      kyc: kyc ? { status: kyc.status, idLast4: kyc.idNumberLast4 } : null,
      collect: apps.map((a) => {
        const snap = (a.planSnapshot ?? {}) as Record<string, number | string | undefined>;
        return {
          applicationId: a.id,
          reference: a.reference,
          type: a.type,
          status: a.status,
          deviceId: a.deviceId,
          variantId: a.variantId,
          device: [deviceName.get(a.deviceId), a.variantId ? storage.get(a.variantId) : null]
            .filter(Boolean)
            .join(' '),
          currency: a.currency,
          depositMinor: Number(snap.depositMinor ?? 0),
          months: Number(snap.months ?? a.financeMonths ?? a.leaseMonths ?? 0),
          frequency: a.type === 'financing' ? a.repaymentFrequency : 'monthly',
          periodMinor: Number(snap.periodMinor ?? snap.monthlyMinor ?? 0),
          periods:
            Number(snap.periods ?? 0) ||
            periodsFor(Number(snap.months ?? 0) || 1, a.repaymentFrequency),
          totalPayableMinor: Number(snap.totalPayableMinor ?? a.amountMinor ?? 0),
        };
      }),
      plans: schedules.map((s) => {
        const open = s.installments.filter((i) => i.status !== 'paid');
        const owed = open.reduce((n, i) => n + i.amountMinor - i.paidAmountMinor, 0);
        const overdue = open
          .filter((i) => i.dueDate.getTime() < now)
          .reduce((n, i) => n + i.amountMinor - i.paidAmountMinor, 0);
        const next = open[0];
        const a = appRef.get(s.applicationId);
        return {
          scheduleId: s.id,
          reference: a?.reference ?? null,
          device: a ? (deviceName.get(a.deviceId) ?? null) : null,
          currency: s.currency,
          owedMinor: owed,
          overdueMinor: overdue,
          nextDue: next
            ? {
                dueDate: next.dueDate.toISOString(),
                amountMinor: next.amountMinor - next.paidAmountMinor,
              }
            : null,
        };
      }),
    };
  }

  /** In-stock phones at the outlet, optionally only one model or one IMEI/serial. */
  async stock(tenantId: string, branchId: string, opts: { deviceId?: string; q?: string }) {
    const where: Prisma.DeviceUnitWhereInput = {
      tenantId,
      branchId,
      status: DeviceUnitStatus.in_stock,
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
    };
    const term = opts.q?.trim();
    if (term) {
      const digits = normalizeImei(term);
      if (isValidImei(digits)) where.imeiHash = this.imei.hash(tenantId, digits);
      else if (/^\d{4}$/.test(digits)) where.imeiLast4 = digits;
      else where.serial = { contains: term, mode: 'insensitive' };
    }
    const [units, total] = await Promise.all([
      this.prisma.deviceUnit.findMany({ where, take: 50, orderBy: { createdAt: 'asc' } }),
      this.prisma.deviceUnit.count({
        where: { tenantId, branchId, status: DeviceUnitStatus.in_stock },
      }),
    ]);
    const priced = await this.price(tenantId, units);
    return {
      inStockAtOutlet: total,
      units: units.map((u) => ({
        id: u.id,
        deviceId: u.deviceId,
        variantId: u.variantId,
        imeiLast4: u.imeiLast4,
        serial: u.serial,
        ...priced.get(u.id)!,
      })),
    };
  }

  /** The agreement the customer will sign, for the counter screen. */
  async agreementPreview(tenantId: string, applicationId: string) {
    const ctx = await this.agreementContext(tenantId, applicationId);
    return { text: agreementText(ctx) };
  }

  // ---------- installment / lease hand-over ----------

  async handover(
    tenantId: string,
    actor: Actor,
    input: {
      applicationId: string;
      branchId?: string;
      unitId: string;
      idCheck: { method: 'kyc_match' | 'manual_override'; note?: string };
      signature: { name: string; imageDataUrl: string };
      deposit?: { method: 'cash' | 'momo'; reference?: string; amountMinor: number };
    },
  ) {
    const branchId = await this.outletFor(tenantId, actor, input.branchId);
    const app = await this.prisma.application.findFirst({
      where: { tenantId, id: input.applicationId },
    });
    if (!app) throw new NotFoundException('Application not found');
    if (!PICKABLE.includes(app.status)) {
      throw new ConflictException('Only an approved application can be handed over');
    }
    if (input.idCheck.method === 'manual_override' && !input.idCheck.note?.trim()) {
      throw new BadRequestException('Say why the ID was checked by hand');
    }
    const unit = await this.prisma.deviceUnit.findFirst({
      where: { tenantId, id: input.unitId },
    });
    if (!unit || unit.status !== DeviceUnitStatus.in_stock || unit.branchId !== branchId) {
      throw new ConflictException('That phone is not in stock at this outlet');
    }
    if (unit.deviceId !== app.deviceId) {
      throw new ConflictException('That phone is a different model from the one approved');
    }
    const signature = decodeSignature(input.signature.imageDataUrl);
    const snap = (app.planSnapshot ?? {}) as { depositMinor?: number };
    const depositDue = app.type === 'financing' ? (snap.depositMinor ?? 0) : 0;
    const depositPaid = await this.prisma.payment.findFirst({
      where: { tenantId, applicationId: app.id, purpose: 'deposit', status: 'succeeded' },
    });
    if (depositDue > 0 && !depositPaid) {
      if (!input.deposit) throw new BadRequestException('Take the deposit before handing over');
      if (input.deposit.amountMinor !== depositDue) {
        throw new BadRequestException(
          `The deposit is ${app.currency ?? ''} ${formatAmount(depositDue, app.currency ?? 'GMD')}`.trim(),
        );
      }
    }

    const text = agreementText(await this.agreementContext(tenantId, app.id));
    const currency = app.currency ?? 'GMD';
    const receipt = await this.prisma.$transaction(async (tx) => {
      // 1. Deposit, taken now (cash or mobile money at the counter).
      const paid =
        depositDue > 0 && !depositPaid && input.deposit
          ? await this.payments.recordCounterPayment(
              {
                tenantId,
                actorId: actor.id,
                customerId: app.customerId,
                purpose: 'deposit',
                applicationId: app.id,
                amountMinor: depositDue,
                currency,
                method: input.deposit.method,
                reference: input.deposit.reference,
                branchId,
              },
              tx,
            )
          : null;
      // 2. The signed agreement, exactly as shown.
      await tx.agreement.upsert({
        where: { tenantId_applicationId: { tenantId, applicationId: app.id } },
        create: {
          tenantId,
          applicationId: app.id,
          text,
          textSha256: createHash('sha256').update(text).digest('hex'),
          signedName: input.signature.name.trim(),
          signatureImage: signature,
          branchId,
          witnessedById: actor.id,
        },
        update: {},
      });
      // 3. approved -> agreement_pending.
      if (app.status === ApplicationStatus.approved) {
        await tx.application.update({
          where: { id: app.id },
          data: { status: ApplicationStatus.agreement_pending },
        });
        await tx.applicationEvent.create({
          data: {
            tenantId,
            applicationId: app.id,
            fromStatus: ApplicationStatus.approved,
            toStatus: ApplicationStatus.agreement_pending,
            actorId: actor.id,
            actorRole: actor.roles.join(','),
            note: 'Agreement signed at the counter',
          },
        });
      }
      return paid;
    });

    // 4. Schedule + active (its own transaction; idempotent if retried).
    const schedule = await this.applications.activate(tenantId, actor, app.id);

    // 5. The phone leaves the outlet with the customer.
    await this.prisma.$transaction(async (tx) => {
      const fulfilment = await tx.fulfilment.upsert({
        where: { tenantId_applicationId: { tenantId, applicationId: app.id } },
        create: {
          tenantId,
          applicationId: app.id,
          branchId,
          agentId: actor.id,
          deviceId: app.deviceId,
          status: FulfilmentStatus.fulfilled,
          idVerified: true,
          idVerifiedMethod: input.idCheck.method,
          fulfilledAt: new Date(),
          imeiLast4: unit.imeiLast4,
          serial: unit.serial,
          deviceUnitId: unit.id,
          notes: input.idCheck.note ?? null,
        },
        update: {
          branchId,
          agentId: actor.id,
          status: FulfilmentStatus.fulfilled,
          idVerified: true,
          idVerifiedMethod: input.idCheck.method,
          fulfilledAt: new Date(),
          imeiLast4: unit.imeiLast4,
          serial: unit.serial,
          deviceUnitId: unit.id,
        },
      });
      const moved = await tx.deviceUnit.updateMany({
        where: { tenantId, id: unit.id, status: DeviceUnitStatus.in_stock },
        data: {
          status: DeviceUnitStatus.active,
          customerId: app.customerId,
          applicationId: app.id,
          fulfilmentId: fulfilment.id,
          activatedAt: new Date(),
        },
      });
      if (moved.count !== 1)
        throw new ConflictException('That phone was just taken by another sale');
    });

    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'pos.handover',
      entity: 'application',
      entityId: app.id,
      after: { unit: unit.imeiLast4, branchId, receipt: receipt?.receiptNumber ?? null },
    });

    const priced = await this.price(tenantId, [unit]);
    await this.payouts.accrue({
      tenantId,
      sourceType: 'application',
      sourceId: app.id,
      sourceRef: app.reference,
      baseMinor: priced.get(unit.id)?.priceMinor ?? 0,
      currency,
      sellerId: actor.id,
      branchId,
    });
    return this.handoverReceipt(
      tenantId,
      app.id,
      branchId,
      actor,
      receipt?.receiptNumber,
      schedule,
    );
  }

  // ---------- cash sale ----------

  async cashSale(
    tenantId: string,
    actor: Actor,
    input: {
      branchId?: string;
      customer: { fullName: string; phone: string; email?: string };
      unitIds: string[];
      payment: { method: 'cash' | 'momo'; reference?: string; amountMinor: number };
    },
  ) {
    const branchId = await this.outletFor(tenantId, actor, input.branchId);
    const ids = [...new Set(input.unitIds)];
    if (ids.length === 0) throw new BadRequestException('Scan at least one phone');
    const units = await this.prisma.deviceUnit.findMany({
      where: { tenantId, id: { in: ids }, branchId, status: DeviceUnitStatus.in_stock },
    });
    if (units.length !== ids.length) {
      throw new ConflictException('Some phones are not in stock at this outlet');
    }
    const priced = await this.price(tenantId, units);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const total = units.reduce((n, u) => n + priced.get(u.id)!.priceMinor, 0);
    if (input.payment.amountMinor < total) {
      throw new BadRequestException(
        `Cash sales are paid in full: ${tenant.currency} ${formatAmount(total, tenant.currency)}`,
      );
    }
    const customerId = await this.customer(tenantId, input.customer);
    const reference = await this.newOrderReference(tenantId);
    const now = new Date();

    const order = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.deviceUnit.updateMany({
        where: { tenantId, id: { in: ids }, status: DeviceUnitStatus.in_stock },
        data: { status: DeviceUnitStatus.sold, customerId, activatedAt: now },
      });
      if (moved.count !== ids.length) {
        throw new ConflictException('A phone was just taken by another sale. Scan again.');
      }
      const created = await tx.order.create({
        data: {
          tenantId,
          reference,
          customerId,
          status: OrderStatus.completed,
          paymentMethod: input.payment.method === 'cash' ? 'cash_at_counter' : 'momo_at_counter',
          paymentStatus: OrderPaymentStatus.paid,
          fulfilmentMethod: 'pickup',
          branchId,
          subtotalMinor: total,
          currency: tenant.currency,
          source: 'counter',
          channel: 'portal',
          paidAmountMinor: input.payment.amountMinor,
          paidAt: now,
          receivedById: actor.id,
          confirmedAt: now,
          readyAt: now,
          completedAt: now,
          notes: input.payment.reference ? `Payment ref ${input.payment.reference}` : null,
          items: {
            create: units.map((u) => {
              const p = priced.get(u.id)!;
              return {
                tenantId,
                deviceId: u.deviceId,
                variantId: u.variantId,
                name: p.model,
                storage: p.storage,
                color: p.color,
                unitPriceMinor: p.priceMinor,
                quantity: 1,
                lineTotalMinor: p.priceMinor,
              };
            }),
          },
        },
      });
      await tx.deviceUnit.updateMany({
        where: { tenantId, id: { in: ids } },
        data: { orderId: created.id },
      });
      for (const u of units) {
        if (u.variantId) {
          await tx.deviceVariant.updateMany({
            where: { tenantId, id: u.variantId, stockQty: { gt: 0 } },
            data: { stockQty: { decrement: 1 } },
          });
        }
      }
      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId: created.id,
          fromStatus: OrderStatus.placed,
          toStatus: OrderStatus.completed,
          actorId: actor.id,
          note: 'Sold at the counter',
        },
      });
      return created;
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'pos.cash_sale',
      entity: 'order',
      entityId: order.id,
      after: { reference, units: units.map((u) => u.imeiLast4), totalMinor: total },
    });

    await this.payouts.accrue({
      tenantId,
      sourceType: 'order',
      sourceId: order.id,
      sourceRef: reference,
      baseMinor: total,
      currency: tenant.currency,
      sellerId: actor.id,
      branchId,
    });
    const [branch, buyer] = await Promise.all([
      this.prisma.branch.findFirst({ where: { tenantId, id: branchId } }),
      this.prisma.user.findFirst({ where: { tenantId, id: customerId }, select: { phone: true } }),
    ]);
    return {
      kind: 'cash_sale' as const,
      receiptNumber: reference,
      reference,
      issuedAt: now.toISOString(),
      outlet: branch?.name ?? null,
      country: tenant.name,
      currency: tenant.currency,
      customer: { name: input.customer.fullName, phone: buyer?.phone ?? input.customer.phone },
      lines: units.map((u) => {
        const p = priced.get(u.id)!;
        return {
          label: [p.model, p.storage, p.color].filter(Boolean).join(' '),
          imeiLast4: u.imeiLast4,
          amountMinor: p.priceMinor,
        };
      }),
      totalMinor: total,
      paidMinor: input.payment.amountMinor,
      changeMinor: input.payment.amountMinor - total,
      method: input.payment.method,
    };
  }

  // ---------- repayment at the counter ----------

  async repayment(
    tenantId: string,
    actor: Actor,
    input: {
      branchId?: string;
      scheduleId: string;
      amountMinor: number;
      method: 'cash' | 'momo';
      reference?: string;
    },
  ) {
    const branchId = await this.outletFor(tenantId, actor, input.branchId);
    const schedule = await this.prisma.repaymentSchedule.findFirst({
      where: { tenantId, id: input.scheduleId },
    });
    if (!schedule) throw new NotFoundException('Plan not found');
    const paid = await this.payments.recordCounterPayment({
      tenantId,
      actorId: actor.id,
      customerId: schedule.customerId,
      purpose: 'installment',
      scheduleId: schedule.id,
      applicationId: schedule.applicationId,
      amountMinor: input.amountMinor,
      currency: schedule.currency,
      method: input.method,
      reference: input.reference,
      branchId,
    });
    const [tenant, customer, app, branch, remaining] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.prisma.user.findFirst({ where: { tenantId, id: schedule.customerId } }),
      this.prisma.application.findFirst({ where: { tenantId, id: schedule.applicationId } }),
      this.prisma.branch.findFirst({ where: { tenantId, id: branchId } }),
      this.prisma.installment.findMany({
        where: { tenantId, scheduleId: schedule.id, status: { not: 'paid' } },
        orderBy: { seq: 'asc' },
      }),
    ]);
    return {
      kind: 'repayment' as const,
      receiptNumber: paid.receiptNumber,
      reference: app?.reference ?? null,
      issuedAt: new Date().toISOString(),
      outlet: branch?.name ?? null,
      country: tenant.name,
      currency: schedule.currency,
      customer: { name: customer?.fullName ?? 'Customer', phone: customer?.phone ?? null },
      lines: [{ label: 'Repayment', imeiLast4: null, amountMinor: input.amountMinor }],
      totalMinor: input.amountMinor,
      paidMinor: input.amountMinor,
      changeMinor: 0,
      method: input.method,
      stillOwedMinor: remaining.reduce((n, i) => n + i.amountMinor - i.paidAmountMinor, 0),
      nextDue: remaining[0]
        ? {
            dueDate: remaining[0].dueDate.toISOString(),
            amountMinor: remaining[0].amountMinor - remaining[0].paidAmountMinor,
          }
        : null,
    };
  }

  // ---------- today at this outlet ----------

  async today(tenantId: string, actor: Actor, branchId?: string) {
    const outlet = await this.outletFor(tenantId, actor, branchId);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [handovers, cashSales, payments, stock, branch] = await Promise.all([
      this.prisma.fulfilment.count({
        where: { tenantId, branchId: outlet, status: 'fulfilled', fulfilledAt: { gte: start } },
      }),
      this.prisma.order.aggregate({
        where: { tenantId, branchId: outlet, source: 'counter', completedAt: { gte: start } },
        _count: { _all: true },
        _sum: { subtotalMinor: true },
      }),
      this.prisma.payment.groupBy({
        by: ['provider'],
        where: {
          tenantId,
          branchId: outlet,
          channel: 'counter',
          status: 'succeeded',
          createdAt: { gte: start },
        },
        _sum: { amountMinor: true },
      }),
      this.prisma.deviceUnit.count({
        where: { tenantId, branchId: outlet, status: DeviceUnitStatus.in_stock },
      }),
      this.prisma.branch.findFirst({ where: { tenantId, id: outlet } }),
    ]);
    const sum = (p: string) => payments.find((x) => x.provider === p)?._sum.amountMinor ?? 0;
    return {
      outlet: { id: outlet, name: branch?.name ?? 'Outlet' },
      handovers,
      cashSales: cashSales._count._all,
      cashSalesMinor: cashSales._sum.subtotalMinor ?? 0,
      collectedCashMinor: sum('counter_cash'),
      collectedMomoMinor: sum('counter_momo'),
      inStock: stock,
    };
  }

  // ---------- internals ----------

  private async agreementContext(tenantId: string, applicationId: string) {
    const app = await this.prisma.application.findFirst({ where: { tenantId, id: applicationId } });
    if (!app) throw new NotFoundException('Application not found');
    const [tenant, customer, device, variant] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.prisma.user.findFirst({ where: { tenantId, id: app.customerId } }),
      this.prisma.device.findFirst({ where: { tenantId, id: app.deviceId } }),
      app.variantId
        ? this.prisma.deviceVariant.findFirst({ where: { tenantId, id: app.variantId } })
        : null,
    ]);
    return {
      country: tenant.name,
      reference: app.reference ?? app.id,
      type: app.type,
      customerName: customer?.fullName ?? 'Customer',
      customerPhone: customer?.phone ?? '',
      device: [device?.name ?? 'Device', variant?.storage].filter(Boolean).join(' '),
      currency: app.currency ?? tenant.currency,
      snapshot: (app.planSnapshot ?? {}) as Record<string, unknown>,
      frequency: app.repaymentFrequency,
    };
  }

  private async handoverReceipt(
    tenantId: string,
    applicationId: string,
    branchId: string,
    actor: Actor,
    receiptNumber: string | undefined,
    schedule: unknown,
  ) {
    const [app, tenant, branch, unit, agent] = await Promise.all([
      this.prisma.application.findFirstOrThrow({ where: { tenantId, id: applicationId } }),
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.prisma.branch.findFirst({ where: { tenantId, id: branchId } }),
      this.prisma.deviceUnit.findFirst({ where: { tenantId, applicationId } }),
      this.prisma.user.findFirst({ where: { id: actor.id }, select: { fullName: true } }),
    ]);
    const customer = await this.prisma.user.findFirst({ where: { tenantId, id: app.customerId } });
    const device = await this.prisma.device.findFirst({ where: { tenantId, id: app.deviceId } });
    const inst =
      (
        schedule as {
          installments?: Array<{
            seq: number;
            dueDate: Date;
            amountMinor: number;
            isDeposit: boolean;
          }>;
        }
      )?.installments ?? [];
    const snap = (app.planSnapshot ?? {}) as { depositMinor?: number; totalPayableMinor?: number };
    return {
      kind: 'handover' as const,
      receiptNumber: receiptNumber ?? app.reference ?? app.id,
      reference: app.reference,
      issuedAt: new Date().toISOString(),
      outlet: branch?.name ?? null,
      agent: agent?.fullName ?? null,
      country: tenant.name,
      currency: app.currency ?? tenant.currency,
      customer: { name: customer?.fullName ?? 'Customer', phone: customer?.phone ?? null },
      device: device?.name ?? 'Device',
      imeiLast4: unit?.imeiLast4 ?? null,
      type: app.type,
      frequency: app.repaymentFrequency,
      depositMinor: snap.depositMinor ?? 0,
      totalPayableMinor: snap.totalPayableMinor ?? app.amountMinor ?? 0,
      upcoming: inst
        .filter((i) => !i.isDeposit)
        .slice(0, 4)
        .map((i) => ({
          seq: i.seq,
          dueDate: new Date(i.dueDate).toISOString(),
          amountMinor: i.amountMinor,
        })),
      payments: inst.filter((i) => !i.isDeposit).length,
    };
  }

  // Price, model name, storage and colour per unit (catalog price + storage delta).
  private async price(
    tenantId: string,
    units: Array<{ id: string; deviceId: string; variantId: string | null }>,
  ) {
    const [devices, variants] = await Promise.all([
      this.prisma.device.findMany({
        where: { tenantId, id: { in: [...new Set(units.map((u) => u.deviceId))] } },
        select: { id: true, name: true, cashPriceMinor: true },
      }),
      this.prisma.deviceVariant.findMany({
        where: {
          tenantId,
          id: { in: units.map((u) => u.variantId).filter((v): v is string => !!v) },
        },
        select: { id: true, storage: true, color: true, priceDeltaMinor: true },
      }),
    ]);
    const d = new Map(devices.map((x) => [x.id, x]));
    const v = new Map(variants.map((x) => [x.id, x]));
    return new Map(
      units.map((u) => {
        const dev = d.get(u.deviceId);
        const variant = u.variantId ? v.get(u.variantId) : undefined;
        return [
          u.id,
          {
            model: dev?.name ?? 'Device',
            storage: variant?.storage ?? null,
            color: variant?.color ?? null,
            priceMinor: (dev?.cashPriceMinor ?? 0) + (variant?.priceDeltaMinor ?? 0),
          },
        ];
      }),
    );
  }

  private async customer(
    tenantId: string,
    who: { fullName: string; phone: string; email?: string },
  ) {
    const digits = who.phone.replace(/\D/g, '');
    if (digits.length < 7) throw new BadRequestException('Enter the customer’s phone number');
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const dial = (tenant.dialCode ?? '').replace(/\D/g, '');
    const phone = who.phone.trim().startsWith('+')
      ? `+${digits}`
      : `+${dial && !digits.startsWith(dial) ? dial : ''}${digits}`;
    const found = await this.prisma.user.findFirst({ where: { tenantId, phone } });
    if (found) {
      if (found.isStaff) throw new BadRequestException('Use a customer phone number');
      return found.id;
    }
    const email = who.email?.trim().toLowerCase() || null;
    const emailTaken = email
      ? await this.prisma.user.findFirst({ where: { tenantId, email }, select: { id: true } })
      : null;
    const created = await this.prisma.user.create({
      data: {
        tenantId,
        phone,
        fullName: who.fullName.trim(),
        email: emailTaken ? null : email,
        roles: { create: { tenantId, role: Role.customer } },
      },
    });
    return created.id;
  }

  private async newOrderReference(tenantId: string) {
    for (let i = 0; i < 5; i++) {
      const ref = `ORD-${Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('')}`;
      if (!(await this.prisma.order.findFirst({ where: { tenantId, reference: ref } }))) return ref;
    }
    throw new ConflictException('Could not create a reference. Try again.');
  }
}

function decodeSignature(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new BadRequestException('The signature must be drawn on screen');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > MAX_SIGNATURE_BYTES || !PNG.every((b, i) => bytes[i] === b)) {
    throw new BadRequestException('The signature image is not valid');
  }
  return bytes;
}
