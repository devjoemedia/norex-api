import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PayoutStatus, Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

interface Actor {
  id: string;
  roles: string[];
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A share in basis points of a price, rounded down to whole minor units. */
export function shareOf(baseMinor: number, bps: number): number {
  return Math.floor((baseMinor * bps) / 10_000);
}

// What Norex owes for sales (docs/23): agents earn a commission on each sale they
// make; partner outlets earn a fee on each plan handed over at their counter. Rates
// are per country. Payouts are grouped per payee into a batch, then marked paid.
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger('Payouts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records what's owed for one sale. Idempotent per (sale, kind) and never throws:
   * a payout problem must not undo a completed sale.
   */
  async accrue(input: {
    tenantId: string;
    sourceType: 'application' | 'order';
    sourceId: string;
    sourceRef?: string | null;
    baseMinor: number;
    currency: string;
    sellerId?: string | null;
    branchId?: string | null;
  }) {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: input.tenantId } });
      if (!tenant || input.baseMinor <= 0) return;
      const lines: Prisma.PayoutCreateManyInput[] = [];

      if (input.sellerId && tenant.agentCommissionBps > 0) {
        const isAgent = await this.prisma.userRole.findFirst({
          where: { tenantId: input.tenantId, userId: input.sellerId, role: 'agent' },
        });
        if (isAgent) {
          lines.push(
            this.line(input, 'agent', input.sellerId, 'commission', tenant.agentCommissionBps),
          );
        }
      }
      if (input.branchId && input.sourceType === 'application' && tenant.partnerOutletFeeBps > 0) {
        const branch = await this.prisma.branch.findFirst({
          where: { tenantId: input.tenantId, id: input.branchId },
        });
        if (branch?.type === 'partner') {
          lines.push(
            this.line(input, 'outlet', branch.id, 'outlet_fee', tenant.partnerOutletFeeBps),
          );
        }
      }
      const owed = lines.filter((l) => l.amountMinor > 0);
      if (owed.length) await this.prisma.payout.createMany({ data: owed, skipDuplicates: true });
    } catch (e) {
      this.logger.warn(
        `payout not recorded for ${input.sourceType} ${input.sourceId}: ${(e as Error).message}`,
      );
    }
  }

  /** Cancels what's still unpaid for a sale (e.g. a refunded order). */
  async voidFor(tenantId: string, sourceType: 'application' | 'order', sourceId: string) {
    await this.prisma.payout.updateMany({
      where: { tenantId, sourceType, sourceId, status: PayoutStatus.pending },
      data: { status: PayoutStatus.void },
    });
  }

  async overview(tenantId: string) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [lines, batches, paidMonth, tenant] = await Promise.all([
      this.prisma.payout.findMany({
        where: {
          tenantId,
          status: { in: [PayoutStatus.pending, PayoutStatus.batched, PayoutStatus.paid] },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.payoutBatch.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.payoutBatch.aggregate({
        where: { tenantId, status: 'paid', paidAt: { gte: monthStart } },
        _sum: { totalMinor: true },
      }),
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
    ]);
    const names = await this.payeeNames(tenantId, [
      ...lines.map((l) => ({ type: l.payeeType, id: l.payeeId })),
      ...batches.map((b) => ({ type: b.payeeType, id: b.payeeId })),
    ]);
    const pending = lines.filter((l) => l.status === PayoutStatus.pending);

    // Who is owed what right now, biggest first.
    const byPayee = new Map<
      string,
      { payeeType: string; payeeId: string; name: string; pendingMinor: number; count: number }
    >();
    for (const l of pending) {
      const key = `${l.payeeType}:${l.payeeId}`;
      const p = byPayee.get(key) ?? {
        payeeType: l.payeeType,
        payeeId: l.payeeId,
        name: names.get(key) ?? 'Unknown',
        pendingMinor: 0,
        count: 0,
      };
      p.pendingMinor += l.amountMinor;
      p.count += 1;
      byPayee.set(key, p);
    }

    return {
      currency: tenant?.currency ?? null,
      rates: {
        agentCommissionBps: tenant?.agentCommissionBps ?? 0,
        partnerOutletFeeBps: tenant?.partnerOutletFeeBps ?? 0,
      },
      stats: {
        pendingMinor: pending.reduce((n, l) => n + l.amountMinor, 0),
        pendingCount: pending.length,
        openBatches: batches.filter((b) => b.status === 'open').length,
        paidThisMonthMinor: paidMonth._sum.totalMinor ?? 0,
      },
      payees: [...byPayee.values()].sort((a, b) => b.pendingMinor - a.pendingMinor),
      rows: lines.map((l) => ({
        id: l.id,
        payeeType: l.payeeType,
        payee: names.get(`${l.payeeType}:${l.payeeId}`) ?? 'Unknown',
        kind: l.kind,
        sourceType: l.sourceType,
        sourceRef: l.sourceRef,
        baseMinor: l.baseMinor,
        amountMinor: l.amountMinor,
        currency: l.currency,
        status: l.status,
        createdAt: l.createdAt.toISOString(),
      })),
      batches: batches.map((b) => ({
        id: b.id,
        reference: b.reference,
        payeeType: b.payeeType,
        payee: names.get(`${b.payeeType}:${b.payeeId}`) ?? 'Unknown',
        totalMinor: b.totalMinor,
        currency: b.currency,
        status: b.status,
        method: b.method,
        paymentRef: b.paymentRef,
        createdAt: b.createdAt.toISOString(),
        paidAt: b.paidAt?.toISOString() ?? null,
      })),
    };
  }

  /** An agent's own earnings (shown at the counter). */
  async mine(tenantId: string, userId: string) {
    const lines = await this.prisma.payout.findMany({
      where: { tenantId, payeeType: 'agent', payeeId: userId, status: { not: PayoutStatus.void } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const sum = (s: PayoutStatus[]) =>
      lines.filter((l) => s.includes(l.status)).reduce((n, l) => n + l.amountMinor, 0);
    return {
      owedMinor: sum([PayoutStatus.pending, PayoutStatus.batched]),
      paidMinor: sum([PayoutStatus.paid]),
      recent: lines.slice(0, 20).map((l) => ({
        id: l.id,
        sourceRef: l.sourceRef,
        amountMinor: l.amountMinor,
        currency: l.currency,
        status: l.status,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /** Everything pending for one payee goes into a new batch. */
  async createBatch(tenantId: string, actor: Actor, payeeType: string, payeeId: string) {
    const pending = await this.prisma.payout.findMany({
      where: { tenantId, payeeType, payeeId, status: PayoutStatus.pending },
    });
    if (pending.length === 0) throw new ConflictException('Nothing is owed to this payee');
    const reference = await this.newReference(tenantId);
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payoutBatch.create({
        data: {
          tenantId,
          reference,
          payeeType,
          payeeId,
          totalMinor: pending.reduce((n, l) => n + l.amountMinor, 0),
          currency: pending[0].currency,
          createdById: actor.id,
        },
      });
      const moved = await tx.payout.updateMany({
        where: { tenantId, id: { in: pending.map((l) => l.id) }, status: PayoutStatus.pending },
        data: { status: PayoutStatus.batched, batchId: created.id },
      });
      if (moved.count !== pending.length)
        throw new ConflictException('Payouts changed. Try again.');
      return created;
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'payouts.batch_created',
      entity: 'payout_batch',
      entityId: batch.id,
      after: { reference, payeeType, payeeId, totalMinor: batch.totalMinor, lines: pending.length },
    });
    return batch;
  }

  async markPaid(
    tenantId: string,
    actor: Actor,
    batchId: string,
    input: { method: 'momo' | 'bank' | 'cash'; paymentRef?: string },
  ) {
    const batch = await this.prisma.payoutBatch.findFirst({ where: { tenantId, id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status === 'paid') throw new ConflictException('This batch is already paid');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.payoutBatch.update({
        where: { id: batchId },
        data: {
          status: 'paid',
          method: input.method,
          paymentRef: input.paymentRef?.trim() || null,
          paidAt: now,
          paidById: actor.id,
        },
      }),
      this.prisma.payout.updateMany({
        where: { tenantId, batchId, status: PayoutStatus.batched },
        data: { status: PayoutStatus.paid },
      }),
    ]);
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'payouts.batch_paid',
      entity: 'payout_batch',
      entityId: batchId,
      after: {
        method: input.method,
        paymentRef: input.paymentRef ?? null,
        totalMinor: batch.totalMinor,
      },
    });
    return { id: batchId, status: 'paid' };
  }

  // ---------- internals ----------

  private line(
    input: {
      tenantId: string;
      sourceType: string;
      sourceId: string;
      sourceRef?: string | null;
      baseMinor: number;
      currency: string;
    },
    payeeType: string,
    payeeId: string,
    kind: string,
    bps: number,
  ): Prisma.PayoutCreateManyInput {
    return {
      tenantId: input.tenantId,
      payeeType,
      payeeId,
      kind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceRef: input.sourceRef ?? null,
      baseMinor: input.baseMinor,
      amountMinor: shareOf(input.baseMinor, bps),
      currency: input.currency,
    };
  }

  private async payeeNames(tenantId: string, payees: Array<{ type: string; id: string }>) {
    const agentIds = [...new Set(payees.filter((p) => p.type === 'agent').map((p) => p.id))];
    const outletIds = [...new Set(payees.filter((p) => p.type === 'outlet').map((p) => p.id))];
    const [users, branches] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId, id: { in: agentIds } },
        select: { id: true, fullName: true, email: true },
      }),
      this.prisma.branch.findMany({
        where: { tenantId, id: { in: outletIds } },
        select: { id: true, name: true },
      }),
    ]);
    return new Map<string, string>([
      ...users.map((u): [string, string] => [`agent:${u.id}`, u.fullName ?? u.email ?? 'Agent']),
      ...branches.map((b): [string, string] => [`outlet:${b.id}`, b.name]),
    ]);
  }

  private async newReference(tenantId: string) {
    for (let i = 0; i < 5; i++) {
      const ref = `PAY-${Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('')}`;
      if (!(await this.prisma.payoutBatch.findFirst({ where: { tenantId, reference: ref } })))
        return ref;
    }
    throw new ConflictException('Could not create a reference. Try again.');
  }
}
