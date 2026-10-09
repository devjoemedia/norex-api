import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { currencyOf } from '../../common/tenancy/currency';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  Application,
  ApplicationStatus,
  Installment,
  InstallmentStatus,
  LedgerAccount,
  LedgerDirection,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  ScheduleKind,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';
import { canTransition } from '../applications/application.constants';
import { ProviderRegistry } from './providers/provider.registry';
import { LedgerService } from './ledger.service';
import { buildSchedule } from './schedule.builder';
import { InitiatePaymentDto, RefundDto } from './dto/payments.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { formatAmount } from '../../common/tenancy/money-text';

interface Actor {
  id: string;
  roles: string[];
}

const STAFF_READ = ['agent', 'approvals_officer', 'country_manager', 'super_admin'];

// Snapshot fields the schedule generator needs (docs/04/05). Stored immutably at
// application submit, so later rate edits never change an active schedule.
interface PlanSnapshot {
  depositMinor?: number;
  monthlyMinor?: number;
  finalMonthlyMinor?: number;
  months?: number;
  currency?: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly registry: ProviderRegistry,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  private encKey(): string {
    return this.config.get<string>('ENCRYPTION_KEY') ?? this.config.get<string>('JWT_SECRET')!;
  }

  private isStaff(roles: string[]): boolean {
    return roles.some((r) => STAFF_READ.includes(r));
  }

  private snapshot(app: Application): PlanSnapshot {
    return (app.planSnapshot as PlanSnapshot | null) ?? {};
  }

  // ---------------- activation (called by applications on agreement_pending -> active) ----------------
  async activateFromApplication(tenantId: string, actor: Actor, applicationId: string) {
    const existing = await this.prisma.repaymentSchedule.findFirst({
      where: { tenantId, applicationId },
      include: { installments: { orderBy: { seq: 'asc' } } },
    });
    if (existing) return existing; // idempotent

    return this.prisma.$transaction(async (tx) => {
      const app = await tx.application.findFirst({ where: { id: applicationId, tenantId } });
      if (!app) throw new NotFoundException('Application not found');
      if (!canTransition(app.status, ApplicationStatus.active)) {
        throw new ConflictException(`Cannot activate from "${app.status}"`);
      }
      const snap = this.snapshot(app);
      const kind = app.type === 'lease' ? ScheduleKind.lease : ScheduleKind.financing;
      const months = snap.months ?? app.financeMonths ?? app.leaseMonths ?? 0;
      const monthly = snap.monthlyMinor ?? 0;
      if (months < 1 || monthly <= 0) {
        throw new BadRequestException('Application has no usable plan snapshot');
      }
      const depositMinor = kind === ScheduleKind.financing ? (snap.depositMinor ?? 0) : 0;

      // Financing requires a settled deposit before it can go active (docs/09).
      if (kind === ScheduleKind.financing && depositMinor > 0) {
        const deposit = await tx.payment.findFirst({
          where: {
            tenantId,
            applicationId,
            purpose: PaymentPurpose.deposit,
            status: PaymentStatus.succeeded,
          },
        });
        if (!deposit) throw new ConflictException('Deposit has not been paid');
      }

      const built = buildSchedule({
        kind: kind === ScheduleKind.lease ? 'lease' : 'financing',
        currency: snap.currency ?? app.currency ?? (await this.tenantCurrency(tenantId)),
        months,
        depositMinor,
        monthlyMinor: monthly,
        finalMonthlyMinor: snap.finalMonthlyMinor ?? monthly,
        activatedAt: new Date(),
      });

      const schedule = await tx.repaymentSchedule.create({
        data: {
          tenantId,
          applicationId,
          customerId: app.customerId,
          kind,
          currency: built.currency,
          totalAmountMinor: built.totalAmountMinor,
          installments: {
            create: built.installments.map((i) => ({
              tenantId,
              seq: i.seq,
              isDeposit: i.isDeposit,
              dueDate: i.dueDate,
              amountMinor: i.amountMinor,
              // the deposit is already settled by its own payment
              status: i.isDeposit ? InstallmentStatus.paid : InstallmentStatus.due,
              paidAmountMinor: i.isDeposit ? i.amountMinor : 0,
              paidAt: i.isDeposit ? new Date() : null,
            })),
          },
        },
        include: { installments: { orderBy: { seq: 'asc' } } },
      });

      await tx.application.update({
        where: { id: applicationId },
        data: { status: ApplicationStatus.active },
      });
      await tx.applicationEvent.create({
        data: {
          tenantId,
          applicationId,
          fromStatus: app.status,
          toStatus: ApplicationStatus.active,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          note: 'Repayment schedule generated',
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'payments.schedule.activated',
          entity: 'repayment_schedule',
          entityId: schedule.id,
          after: {
            applicationId,
            totalAmountMinor: built.totalAmountMinor,
            installments: built.installments.length,
          },
        },
      });
      return schedule;
    });
  }

  // ---------------- reads ----------------
  async getSchedule(tenantId: string, user: Actor, id: string) {
    const schedule = await this.prisma.repaymentSchedule.findFirst({
      where: { id, tenantId },
      include: { installments: { orderBy: { seq: 'asc' } } },
    });
    if (!schedule) throw new NotFoundException('Schedule not found');
    if (!this.isStaff(user.roles) && schedule.customerId !== user.id) {
      throw new ForbiddenException('Not your schedule');
    }
    return schedule;
  }

  myInstallments(tenantId: string, user: Actor, status?: InstallmentStatus) {
    return this.prisma.installment.findMany({
      where: {
        tenantId,
        status,
        schedule: { customerId: user.id },
      },
      orderBy: { dueDate: 'asc' },
    });
  }

  async getPayment(tenantId: string, user: Actor, id: string) {
    const payment = await this.prisma.payment.findFirst({ where: { id, tenantId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (!this.isStaff(user.roles) && payment.customerId !== user.id) {
      throw new ForbiddenException('Not your payment');
    }
    return payment;
  }

  // ---------------- initiate ----------------
  async initiate(tenantId: string, user: Actor, dto: InitiatePaymentDto, idemKey?: string) {
    if (!idemKey) throw new BadRequestException('Idempotency-Key header is required');

    const cfg = await this.prisma.providerConfig.findFirst({
      where: { tenantId, provider: dto.provider, active: true },
    });
    if (!cfg || !this.registry.isKnown(dto.provider)) {
      throw new BadRequestException('Payment provider is not enabled for this tenant');
    }

    // Validate the amount against what is actually owed, per purpose.
    let installmentId: string | undefined;
    let scheduleId: string | undefined;
    let applicationId: string | undefined;

    if (dto.purpose === PaymentPurpose.deposit) {
      if (!dto.applicationId)
        throw new BadRequestException('applicationId is required for a deposit');
      const app = await this.prisma.application.findFirst({
        where: { id: dto.applicationId, tenantId },
      });
      if (!app) throw new NotFoundException('Application not found');
      if (app.customerId !== user.id) throw new ForbiddenException('Not your application');
      const expected = this.snapshot(app).depositMinor ?? 0;
      if (dto.amountMinor !== expected)
        throw new BadRequestException('Deposit amount does not match the plan');
      applicationId = app.id;
    } else {
      if (!dto.installmentId) throw new BadRequestException('installmentId is required');
      const inst = await this.prisma.installment.findFirst({
        where: { id: dto.installmentId, tenantId },
        include: { schedule: true },
      });
      if (!inst) throw new NotFoundException('Installment not found');
      if (inst.schedule.customerId !== user.id)
        throw new ForbiddenException('Not your installment');
      if (inst.status === InstallmentStatus.paid)
        throw new ConflictException('Installment already paid');
      const remaining = inst.amountMinor - inst.paidAmountMinor;
      if (dto.amountMinor !== remaining)
        throw new BadRequestException('Amount must equal the outstanding balance');
      installmentId = inst.id;
      scheduleId = inst.scheduleId;
    }

    // Idempotent create: a retry with the same key returns the first payment.
    let payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          tenantId,
          customerId: user.id,
          applicationId,
          scheduleId,
          installmentId,
          purpose: dto.purpose,
          provider: dto.provider,
          channel: dto.channel,
          amountMinor: dto.amountMinor,
          currency:
            (await this.currencyFor(tenantId, applicationId, scheduleId)) ??
            (await this.tenantCurrency(tenantId)),
          status: PaymentStatus.initiated,
          idempotencyKey: idemKey,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.payment.findFirstOrThrow({
          where: { tenantId, idempotencyKey: idemKey },
        });
      }
      throw e;
    }

    const provider = this.registry.get(dto.provider);
    const handoff = await provider.initiate({
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      reference: payment.id,
      channel: dto.channel,
    });
    return this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerRef: handoff.providerRef,
        ussdCode: handoff.ussdCode,
        status: PaymentStatus.pending,
      },
    });
  }

  // Last resort when neither the schedule nor the application carries a currency.
  private async tenantCurrency(tenantId: string): Promise<string> {
    return currencyOf(await this.prisma.tenant.findUnique({ where: { id: tenantId } }));
  }

  private async currencyFor(
    tenantId: string,
    applicationId?: string,
    scheduleId?: string,
  ): Promise<string | null> {
    if (scheduleId) {
      const s = await this.prisma.repaymentSchedule.findFirst({
        where: { id: scheduleId, tenantId },
      });
      return s?.currency ?? null;
    }
    if (applicationId) {
      const a = await this.prisma.application.findFirst({ where: { id: applicationId, tenantId } });
      return a?.currency ?? this.snapshot(a as Application).currency ?? null;
    }
    return null;
  }

  // ---------------- webhook ----------------
  async handleWebhook(tenantId: string, providerKey: string, rawBody: string, signature?: string) {
    const provider = this.registry.get(providerKey);
    const cfg = await this.prisma.providerConfig.findFirst({
      where: { tenantId, provider: providerKey, active: true },
    });
    if (!cfg) throw new BadRequestException('Provider not enabled');
    const secret = decryptSecret(cfg.webhookSecretCipher, this.encKey());
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    // Do no work before verifying the signature.
    if (!provider.verifySignature(rawBody, signature, secret)) {
      await this.prisma.webhookEvent
        .create({
          data: {
            tenantId,
            provider: providerKey,
            eventId: `unsigned-${payloadHash.slice(0, 24)}`,
            signatureVerified: false,
            payloadHash,
            result: 'invalid_signature',
            processedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException('Malformed webhook body');
    }
    const event = provider.parseEvent(parsed);

    // Dedupe: a re-delivered event must never post twice.
    try {
      await this.prisma.webhookEvent.create({
        data: {
          tenantId,
          provider: providerKey,
          eventId: event.eventId,
          signatureVerified: true,
          payloadHash,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { status: 'duplicate' };
      }
      throw e;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { tenantId, provider: providerKey, providerRef: event.providerRef },
    });
    if (!payment) {
      await this.markEvent(tenantId, providerKey, event.eventId, 'unknown_payment');
      return { status: 'unknown_payment' };
    }

    // Never trust the reported amount: a mismatch is quarantined, not applied.
    if (event.amountMinor !== payment.amountMinor || event.currency !== payment.currency) {
      await this.markEvent(tenantId, providerKey, event.eventId, 'amount_mismatch');
      return { status: 'amount_mismatch' };
    }

    if (event.status === 'failed') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.failed, failureReason: 'provider reported failure' },
      });
      await this.markEvent(tenantId, providerKey, event.eventId, 'failed');
      return { status: 'failed' };
    }

    const receiptNumber = await this.prisma.$transaction(async (tx): Promise<string | null> => {
      // Only apply once even if a duplicate slips past the event dedupe.
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (fresh.status === PaymentStatus.succeeded) return null;

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.succeeded },
      });

      const creditAccount =
        payment.purpose === PaymentPurpose.deposit
          ? LedgerAccount.deposit_liability
          : LedgerAccount.customer_receivable;
      await this.ledger.post(
        tx,
        tenantId,
        payment.currency,
        [
          {
            account: LedgerAccount.cash_momo,
            direction: LedgerDirection.debit,
            amountMinor: payment.amountMinor,
          },
          {
            account: creditAccount,
            direction: LedgerDirection.credit,
            amountMinor: payment.amountMinor,
          },
        ],
        {
          paymentId: payment.id,
          installmentId: payment.installmentId ?? undefined,
          memo: payment.purpose,
        },
      );

      if (payment.installmentId) {
        const inst = await tx.installment.findUniqueOrThrow({
          where: { id: payment.installmentId },
        });
        const paidAmountMinor = inst.paidAmountMinor + payment.amountMinor;
        const fullyPaid = paidAmountMinor >= inst.amountMinor;
        await tx.installment.update({
          where: { id: inst.id },
          data: {
            paidAmountMinor,
            status: fullyPaid ? InstallmentStatus.paid : inst.status,
            paidAt: fullyPaid ? new Date() : inst.paidAt,
          },
        });
        await this.maybeCompleteSchedule(tx, tenantId, inst.scheduleId);
      }

      const number = await this.nextReceiptNumber(tx, tenantId);
      await tx.receipt.create({
        data: {
          tenantId,
          paymentId: payment.id,
          number,
          storageKey: `tenants/${tenantId}/receipts/${payment.id}.pdf`,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: payment.customerId,
          actorRole: 'customer',
          action: 'payments.payment.succeeded',
          entity: 'payment',
          entityId: payment.id,
          after: { amountMinor: payment.amountMinor, purpose: payment.purpose, receipt: number },
        },
      });
      return number;
    });

    await this.markEvent(tenantId, providerKey, event.eventId, 'succeeded');

    // Receipt notification (docs/10). Best-effort — emit never throws.
    if (receiptNumber) {
      await this.notifications.emit({
        tenantId,
        eventKey: 'payment_receipt',
        userId: payment.customerId,
        entityId: payment.id,
        vars: {
          receiptNumber,
          amount: formatAmount(payment.amountMinor, payment.currency),
          currency: payment.currency,
        },
      });
    }
    return { status: 'succeeded' };
  }

  private async maybeCompleteSchedule(
    tx: Prisma.TransactionClient,
    tenantId: string,
    scheduleId: string,
  ) {
    const outstanding = await tx.installment.count({
      where: { tenantId, scheduleId, status: { not: InstallmentStatus.paid } },
    });
    if (outstanding === 0) {
      await tx.repaymentSchedule.update({
        where: { id: scheduleId },
        data: { status: 'completed' },
      });
    }
  }

  private async nextReceiptNumber(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
    const count = await tx.receipt.count({ where: { tenantId } });
    return `RCP-${String(count + 1).padStart(6, '0')}`;
  }

  private markEvent(tenantId: string, provider: string, eventId: string, result: string) {
    return this.prisma.webhookEvent.updateMany({
      where: { tenantId, provider, eventId },
      data: { result, processedAt: new Date() },
    });
  }

  // ---------------- receipts ----------------
  async receiptUrl(tenantId: string, user: Actor, paymentId: string) {
    const payment = await this.getPayment(tenantId, user, paymentId);
    const receipt = await this.prisma.receipt.findFirst({
      where: { tenantId, paymentId: payment.id },
    });
    if (!receipt) throw new NotFoundException('No receipt for this payment yet');
    // TODO: real short-lived signed GET (docs/00/01). Stub keeps the flow complete.
    const base = this.config.get<string>('S3_ENDPOINT') ?? 'https://storage.local';
    return {
      number: receipt.number,
      url: `${base}/${receipt.storageKey}?stub-signed-get`,
      expiresIn: 300,
    };
  }

  // ---------------- admin ----------------
  async configureProvider(tenantId: string, actor: Actor, provider: string, webhookSecret: string) {
    if (!this.registry.isKnown(provider)) throw new BadRequestException('Unknown provider');
    const cipher = encryptSecret(webhookSecret, this.encKey());
    const cfg = await this.prisma.providerConfig.upsert({
      where: { tenantId_provider: { tenantId, provider } },
      update: { webhookSecretCipher: cipher, active: true },
      create: { tenantId, provider, webhookSecretCipher: cipher, active: true },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'payments.provider.configured',
      entity: 'provider_config',
      entityId: cfg.id,
      after: { provider },
    });
    return { id: cfg.id, provider: cfg.provider, active: cfg.active };
  }

  /** Configured providers for the country (never the webhook secret). */
  async listProviders(tenantId: string) {
    const rows = await this.prisma.providerConfig.findMany({
      where: { tenantId },
      orderBy: { provider: 'asc' },
      select: { id: true, provider: true, active: true, updatedAt: true },
    });
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
  }

  async refund(tenantId: string, actor: Actor, paymentId: string, dto: RefundDto) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.status !== PaymentStatus.succeeded) {
        throw new ConflictException('Only a succeeded payment can be refunded');
      }
      if (dto.amountMinor > payment.amountMinor) {
        throw new BadRequestException('Refund exceeds the payment amount');
      }

      // Compensating entries — the ledger is never mutated.
      const debitAccount =
        payment.purpose === PaymentPurpose.deposit
          ? LedgerAccount.deposit_liability
          : LedgerAccount.customer_receivable;
      await this.ledger.post(
        tx,
        tenantId,
        payment.currency,
        [
          { account: debitAccount, direction: LedgerDirection.debit, amountMinor: dto.amountMinor },
          {
            account: LedgerAccount.cash_momo,
            direction: LedgerDirection.credit,
            amountMinor: dto.amountMinor,
          },
        ],
        { paymentId: payment.id, memo: `refund: ${dto.reason}` },
      );

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.reversed },
      });

      if (payment.installmentId) {
        const inst = await tx.installment.findUniqueOrThrow({
          where: { id: payment.installmentId },
        });
        const paidAmountMinor = Math.max(0, inst.paidAmountMinor - dto.amountMinor);
        await tx.installment.update({
          where: { id: inst.id },
          data: {
            paidAmountMinor,
            status:
              paidAmountMinor >= inst.amountMinor ? InstallmentStatus.paid : InstallmentStatus.due,
            paidAt: paidAmountMinor >= inst.amountMinor ? inst.paidAt : null,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'payments.payment.refunded',
          entity: 'payment',
          entityId: payment.id,
          after: { amountMinor: dto.amountMinor, reason: dto.reason },
        },
      });
      // TODO: provider.refund(...) when a live integration is enabled (docs/09).
      return { id: payment.id, status: PaymentStatus.reversed, refundedMinor: dto.amountMinor };
    });
  }

  // Arrears "job": flip newly-overdue installments and send a reminder for each (docs/10).
  // BullMQ scheduling of this job is deferred; it is exposed for the admin arrears view.
  async markOverdue(tenantId: string): Promise<number> {
    const due = await this.prisma.installment.findMany({
      where: { tenantId, status: InstallmentStatus.due, dueDate: { lt: new Date() } },
      include: { schedule: true },
    });
    if (due.length === 0) return 0;
    await this.prisma.installment.updateMany({
      where: { id: { in: due.map((i) => i.id) } },
      data: { status: InstallmentStatus.overdue },
    });
    for (const i of due) {
      await this.notifications.emit({
        tenantId,
        eventKey: 'payment_reminder',
        userId: i.schedule.customerId,
        entityId: `${i.id}:overdue`,
        vars: {
          reference: i.scheduleId.slice(0, 8).toUpperCase(),
          amount: formatAmount(i.amountMinor - i.paidAmountMinor, i.schedule.currency),
          currency: i.schedule.currency,
          dueDate: i.dueDate.toISOString().slice(0, 10),
        },
      });
    }
    return due.length;
  }

  async arrears(tenantId: string): Promise<Installment[]> {
    await this.markOverdue(tenantId);
    return this.prisma.installment.findMany({
      where: { tenantId, status: InstallmentStatus.overdue },
      orderBy: { dueDate: 'asc' },
    });
  }

  // Ledger is the source of truth; the provider report is external evidence.
  async reconciliation(tenantId: string, from?: Date, to?: Date) {
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = from;
    if (to) range.lte = to;
    const createdAt = from || to ? range : undefined;

    const cash = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { tenantId, account: LedgerAccount.cash_momo, ...(createdAt ? { createdAt } : {}) },
      _sum: { amountMinor: true },
    });
    const debit = cash.find((c) => c.direction === LedgerDirection.debit)?._sum.amountMinor ?? 0;
    const credit = cash.find((c) => c.direction === LedgerDirection.credit)?._sum.amountMinor ?? 0;
    const ledgerCashMinor = debit - credit;

    const succeeded = await this.prisma.payment.aggregate({
      where: { tenantId, status: PaymentStatus.succeeded, ...(createdAt ? { createdAt } : {}) },
      _sum: { amountMinor: true },
    });
    const paymentsSucceededMinor = succeeded._sum.amountMinor ?? 0;
    const reversed = await this.prisma.payment.aggregate({
      where: { tenantId, status: PaymentStatus.reversed, ...(createdAt ? { createdAt } : {}) },
      _sum: { amountMinor: true },
    });

    return {
      ledgerCashMinor,
      paymentsSucceededMinor,
      paymentsReversedMinor: reversed._sum.amountMinor ?? 0,
      // net cash should equal succeeded minus reversed when everything reconciles
      diffMinor: ledgerCashMinor - (paymentsSucceededMinor - (reversed._sum.amountMinor ?? 0)),
    };
  }
}
