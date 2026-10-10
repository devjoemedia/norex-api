import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InstallmentStatus, Prisma, RecoveryStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { formatAmount } from '../../common/tenancy/money-text';

interface Actor {
  id: string;
  roles: string[];
}

const DAY = 86_400_000;
/** A plan becomes a recovery case once a payment is this many days late. */
export const OPEN_CASE_AFTER_DAYS = 7;
/** Reminder days relative to the due date (negative = before). */
export const REMINDER_DAYS = [-3, 1, 7, 14] as const;
const OUTCOMES = ['paid_up', 'repossessed', 'written_off', 'other'] as const;
export type Outcome = (typeof OUTCOMES)[number];
const MANAGER_ROLES = ['super_admin', 'admin', 'country_manager', 'approvals_officer'];

/** Which reminder (if any) is due for an installment today. */
export function reminderStage(dueDate: Date, now: Date): (typeof REMINDER_DAYS)[number] | null {
  const days = Math.floor((now.getTime() - dueDate.getTime()) / DAY);
  // Fire on the day itself or, if a run was missed, within the following day.
  return REMINDER_DAYS.find((d) => days === d || days === d + 1) ?? null;
}

// Collections (docs/24): reminders before and after each due date, and a recovery
// case for every plan more than a week behind, worked by staff until it's paid up,
// the phone is recovered, or it's written off.
@Injectable()
export class RecoveryService {
  private readonly log = new Logger('Recovery');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- the hourly job (one country, inside its RLS scope) ----------

  async runFor(tenantId: string, now = new Date()) {
    // 1. Flip late installments to overdue.
    await this.prisma.installment.updateMany({
      where: { tenantId, status: InstallmentStatus.due, dueDate: { lt: now } },
      data: { status: InstallmentStatus.overdue },
    });

    // 2. Reminders: 3 days before, then 1, 7 and 14 days late. Deduped per stage.
    const open = await this.prisma.installment.findMany({
      where: {
        tenantId,
        status: { in: [InstallmentStatus.due, InstallmentStatus.overdue] },
        isDeposit: false,
        dueDate: {
          gte: new Date(now.getTime() - 16 * DAY),
          lte: new Date(now.getTime() + 4 * DAY),
        },
      },
      include: { schedule: true },
    });
    const refs = await this.references(
      tenantId,
      open.map((i) => i.schedule.applicationId),
    );
    let sent = 0;
    for (const i of open) {
      const stage = reminderStage(i.dueDate, now);
      if (stage === null || i.schedule.status !== 'active') continue;
      await this.notifications.emit({
        tenantId,
        eventKey: 'payment_reminder',
        userId: i.schedule.customerId,
        entityId: `${i.id}:d${stage}`,
        vars: {
          reference: refs.get(i.schedule.applicationId) ?? i.scheduleId.slice(0, 8).toUpperCase(),
          amount: formatAmount(i.amountMinor - i.paidAmountMinor, i.schedule.currency),
          currency: i.schedule.currency,
          dueDate: i.dueDate.toISOString().slice(0, 10),
        },
      });
      sent++;
    }

    // 3. Open a case for each plan more than a week behind (one open case per plan).
    const late = await this.prisma.installment.findMany({
      where: {
        tenantId,
        status: InstallmentStatus.overdue,
        dueDate: { lt: new Date(now.getTime() - OPEN_CASE_AFTER_DAYS * DAY) },
      },
      select: { scheduleId: true, schedule: { select: { applicationId: true, customerId: true } } },
      distinct: ['scheduleId'],
    });
    const existing = new Set(
      (
        await this.prisma.recoveryCase.findMany({
          where: { tenantId, status: { not: RecoveryStatus.closed } },
          select: { scheduleId: true },
        })
      ).map((c) => c.scheduleId),
    );
    let opened = 0;
    for (const l of late) {
      if (existing.has(l.scheduleId)) continue;
      await this.prisma.recoveryCase.create({
        data: {
          tenantId,
          scheduleId: l.scheduleId,
          applicationId: l.schedule.applicationId,
          customerId: l.schedule.customerId,
          notes: {
            create: {
              tenantId,
              kind: 'system',
              text: `Opened automatically: a payment is more than ${OPEN_CASE_AFTER_DAYS} days late.`,
            },
          },
        },
      });
      opened++;
    }

    // 4. Close cases whose plan is up to date again.
    const live = await this.prisma.recoveryCase.findMany({
      where: { tenantId, status: { not: RecoveryStatus.closed } },
    });
    let closed = 0;
    for (const c of live) {
      const stillLate = await this.prisma.installment.count({
        where: { tenantId, scheduleId: c.scheduleId, status: InstallmentStatus.overdue },
      });
      if (stillLate === 0) {
        await this.close(
          tenantId,
          c.id,
          'paid_up',
          'Closed automatically: the plan is up to date.',
          null,
        );
        closed++;
      }
    }
    if (sent || opened || closed) {
      this.log.log(
        `tenant ${tenantId.slice(0, 8)}: ${sent} reminders, ${opened} cases opened, ${closed} closed`,
      );
    }
    return { sent, opened, closed };
  }

  // ---------- staff ----------

  async list(tenantId: string, actor: Actor, status?: RecoveryStatus | 'all') {
    const agentOnly = !actor.roles.some((r) => MANAGER_ROLES.includes(r));
    const where: Prisma.RecoveryCaseWhereInput = {
      tenantId,
      ...(status && status !== 'all' ? { status } : { status: { not: RecoveryStatus.closed } }),
      ...(agentOnly ? { assignedToId: actor.id } : {}),
    };
    const cases = await this.prisma.recoveryCase.findMany({
      where,
      orderBy: { openedAt: 'asc' },
      take: 300,
      include: { notes: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const [owed, people, refs] = await Promise.all([
      this.owedBySchedule(
        tenantId,
        cases.map((c) => c.scheduleId),
      ),
      this.prisma.user.findMany({
        where: {
          tenantId,
          id: {
            in: [
              ...cases.map((c) => c.customerId),
              ...cases.map((c) => c.assignedToId).filter((x): x is string => !!x),
            ],
          },
        },
        select: { id: true, fullName: true, phone: true },
      }),
      this.references(
        tenantId,
        cases.map((c) => c.applicationId),
      ),
    ]);
    const person = new Map(people.map((p) => [p.id, p]));
    const counts = await this.prisma.recoveryCase.groupBy({
      by: ['status'],
      where: { tenantId, ...(agentOnly ? { assignedToId: actor.id } : {}) },
      _count: { _all: true },
    });
    const count = (s: RecoveryStatus) => counts.find((c) => c.status === s)?._count._all ?? 0;
    return {
      stats: {
        open: count(RecoveryStatus.open),
        promised: count(RecoveryStatus.promised),
        assigned: count(RecoveryStatus.assigned),
        closed: count(RecoveryStatus.closed),
      },
      rows: cases.map((c) => {
        const o = owed.get(c.scheduleId);
        return {
          id: c.id,
          reference: refs.get(c.applicationId) ?? null,
          customer: person.get(c.customerId)?.fullName ?? 'Customer',
          phone: person.get(c.customerId)?.phone ?? null,
          status: c.status,
          overdueMinor: o?.overdueMinor ?? 0,
          currency: o?.currency ?? null,
          daysLate: o?.daysLate ?? 0,
          assignedTo: c.assignedToId ? (person.get(c.assignedToId)?.fullName ?? 'Staff') : null,
          promiseDate: c.promiseDate?.toISOString() ?? null,
          lastNote: c.notes[0]?.text ?? null,
          openedAt: c.openedAt.toISOString(),
        };
      }),
    };
  }

  async detail(tenantId: string, actor: Actor, id: string) {
    const c = await this.load(tenantId, actor, id);
    const [owed, customer, assignee, refs, unit, notes] = await Promise.all([
      this.owedBySchedule(tenantId, [c.scheduleId]),
      this.prisma.user.findFirst({ where: { tenantId, id: c.customerId } }),
      c.assignedToId ? this.prisma.user.findFirst({ where: { id: c.assignedToId } }) : null,
      this.references(tenantId, [c.applicationId]),
      this.prisma.deviceUnit.findFirst({ where: { tenantId, applicationId: c.applicationId } }),
      this.prisma.recoveryNote.findMany({
        where: { tenantId, caseId: id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const authors = await this.prisma.user.findMany({
      where: { id: { in: notes.map((n) => n.authorId).filter((x): x is string => !!x) } },
      select: { id: true, fullName: true },
    });
    const author = new Map(authors.map((a) => [a.id, a.fullName ?? 'Staff']));
    const o = owed.get(c.scheduleId);
    return {
      id: c.id,
      status: c.status,
      outcome: c.outcome,
      reference: refs.get(c.applicationId) ?? null,
      applicationId: c.applicationId,
      customer: {
        id: c.customerId,
        name: customer?.fullName ?? 'Customer',
        phone: customer?.phone ?? null,
        email: customer?.email ?? null,
      },
      owedMinor: o?.owedMinor ?? 0,
      overdueMinor: o?.overdueMinor ?? 0,
      currency: o?.currency ?? null,
      daysLate: o?.daysLate ?? 0,
      device: unit
        ? { imeiLast4: unit.imeiLast4, status: unit.status, lockState: unit.lockState }
        : null,
      assignedTo: c.assignedToId
        ? { id: c.assignedToId, name: assignee?.fullName ?? 'Staff' }
        : null,
      promise: c.promiseDate
        ? { date: c.promiseDate.toISOString(), amountMinor: c.promiseAmountMinor }
        : null,
      openedAt: c.openedAt.toISOString(),
      closedAt: c.closedAt?.toISOString() ?? null,
      notes: notes.map((n) => ({
        id: n.id,
        kind: n.kind,
        text: n.text,
        by: n.authorId ? (author.get(n.authorId) ?? 'Staff') : 'Norex',
        at: n.createdAt.toISOString(),
      })),
    };
  }

  async addNote(
    tenantId: string,
    actor: Actor,
    id: string,
    input: { kind: 'call' | 'visit' | 'message'; text: string },
  ) {
    await this.load(tenantId, actor, id, true);
    await this.prisma.recoveryNote.create({
      data: { tenantId, caseId: id, kind: input.kind, text: input.text.trim(), authorId: actor.id },
    });
    return this.detail(tenantId, actor, id);
  }

  async promise(
    tenantId: string,
    actor: Actor,
    id: string,
    input: { date: string; amountMinor: number },
  ) {
    await this.load(tenantId, actor, id, true);
    const date = new Date(input.date);
    if (Number.isNaN(date.getTime()) || date.getTime() < Date.now() - DAY) {
      throw new BadRequestException('Pick a date from today on');
    }
    await this.prisma.$transaction([
      this.prisma.recoveryCase.update({
        where: { id },
        data: {
          status: RecoveryStatus.promised,
          promiseDate: date,
          promiseAmountMinor: input.amountMinor,
        },
      }),
      this.prisma.recoveryNote.create({
        data: {
          tenantId,
          caseId: id,
          kind: 'promise',
          text: `Promised to pay by ${date.toISOString().slice(0, 10)}.`,
          authorId: actor.id,
        },
      }),
    ]);
    return this.detail(tenantId, actor, id);
  }

  async assign(tenantId: string, actor: Actor, id: string, userId: string) {
    this.assertManager(actor);
    await this.load(tenantId, actor, id);
    const user = await this.prisma.user.findFirst({
      where: { tenantId, id: userId, isStaff: true, status: 'active' },
    });
    if (!user) throw new NotFoundException('Staff member not found in this country');
    await this.prisma.$transaction([
      this.prisma.recoveryCase.update({
        where: { id },
        data: { status: RecoveryStatus.assigned, assignedToId: userId },
      }),
      this.prisma.recoveryNote.create({
        data: {
          tenantId,
          caseId: id,
          kind: 'assign',
          text: `Assigned to ${user.fullName ?? user.email} for a visit.`,
          authorId: actor.id,
        },
      }),
    ]);
    return this.detail(tenantId, actor, id);
  }

  async closeByStaff(
    tenantId: string,
    actor: Actor,
    id: string,
    input: { outcome: Outcome; note: string },
  ) {
    this.assertManager(actor);
    const c = await this.load(tenantId, actor, id);
    if (c.status === RecoveryStatus.closed)
      throw new ConflictException('This case is already closed');
    if (!OUTCOMES.includes(input.outcome)) throw new BadRequestException('Choose an outcome');
    await this.close(tenantId, id, input.outcome, input.note.trim(), actor.id);
    // A recovered phone is marked repossessed and comes off the customer.
    if (input.outcome === 'repossessed') {
      await this.prisma.deviceUnit.updateMany({
        where: { tenantId, applicationId: c.applicationId },
        data: { status: 'repossessed' },
      });
    }
    if (input.outcome === 'written_off') {
      await this.prisma.repaymentSchedule.updateMany({
        where: { tenantId, id: c.scheduleId },
        data: { status: 'written_off' },
      });
    }
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: `recovery.closed_${input.outcome}`,
      entity: 'recovery_case',
      entityId: id,
    });
    return this.detail(tenantId, actor, id);
  }

  // ---------- internals ----------

  private async close(
    tenantId: string,
    id: string,
    outcome: Outcome,
    text: string,
    authorId: string | null,
  ) {
    await this.prisma.$transaction([
      this.prisma.recoveryCase.update({
        where: { id },
        data: { status: RecoveryStatus.closed, outcome, closedAt: new Date() },
      }),
      this.prisma.recoveryNote.create({
        data: {
          tenantId,
          caseId: id,
          kind: 'close',
          text: text || outcome.replace('_', ' '),
          authorId,
        },
      }),
    ]);
  }

  private assertManager(actor: Actor) {
    if (!actor.roles.some((r) => MANAGER_ROLES.includes(r))) {
      throw new ForbiddenException('Only managers and compliance can do this');
    }
  }

  // Agents only reach the cases assigned to them.
  private async load(tenantId: string, actor: Actor, id: string, forWork = false) {
    const c = await this.prisma.recoveryCase.findFirst({ where: { tenantId, id } });
    if (!c) throw new NotFoundException('Case not found');
    const manager = actor.roles.some((r) => MANAGER_ROLES.includes(r));
    if (!manager && c.assignedToId !== actor.id)
      throw new ForbiddenException('This case is not assigned to you');
    if (forWork && c.status === RecoveryStatus.closed)
      throw new ConflictException('This case is closed');
    return c;
  }

  private async owedBySchedule(tenantId: string, scheduleIds: string[]) {
    const insts = await this.prisma.installment.findMany({
      where: { tenantId, scheduleId: { in: scheduleIds }, status: { not: InstallmentStatus.paid } },
      include: { schedule: { select: { currency: true } } },
    });
    const now = Date.now();
    const out = new Map<
      string,
      { owedMinor: number; overdueMinor: number; daysLate: number; currency: string }
    >();
    for (const i of insts) {
      const o = out.get(i.scheduleId) ?? {
        owedMinor: 0,
        overdueMinor: 0,
        daysLate: 0,
        currency: i.schedule.currency,
      };
      const left = i.amountMinor - i.paidAmountMinor;
      o.owedMinor += left;
      if (i.status === InstallmentStatus.overdue) {
        o.overdueMinor += left;
        o.daysLate = Math.max(o.daysLate, Math.floor((now - i.dueDate.getTime()) / DAY));
      }
      out.set(i.scheduleId, o);
    }
    return out;
  }

  private async references(tenantId: string, applicationIds: string[]) {
    const apps = await this.prisma.application.findMany({
      where: { tenantId, id: { in: [...new Set(applicationIds)] } },
      select: { id: true, reference: true },
    });
    return new Map(apps.map((a) => [a.id, a.reference ?? a.id.slice(0, 8)]));
  }
}
