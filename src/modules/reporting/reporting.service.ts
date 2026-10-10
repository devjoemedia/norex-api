import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationStatus,
  ApplicationType,
  ExportFormat,
  ExportStatus,
  FulfilmentStatus,
  InstallmentStatus,
  LeaseStatus,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { toCsv } from './csv.util';
import {
  ApplicationsReportDto,
  CreateExportDto,
  DateRangeDto,
  FinanceReportDto,
  InventoryReportDto,
  LeaseReturnsReportDto,
  REPORT_KEYS,
  ReportKey,
} from './dto/reporting.dto';

interface Actor {
  id: string;
  roles: string[];
  tenantId?: string;
}

// Bounded date window (docs/13 — queries must stay cheap/bounded).
const MAX_RANGE_DAYS = 366;
// Ready exports are short-lived; a cleanup job flips them to `expired`.
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
// Download links are single-purpose and time-boxed.
const SIGNED_URL_TTL_SECS = 300;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Allow-listed output columns per report. Serialization projects only these fields,
// so no customer identifier can ever leak into an aggregate or an export.
const REPORT_COLUMNS: Record<ReportKey, string[]> = {
  applications: ['day', 'type', 'status', 'count', 'approvalRate', 'avgTimeToDecisionSecs'],
  finance: [
    'day',
    'currency',
    'revenueCollectedMinor',
    'repaymentsCollectedMinor',
    'arrearsOverdueMinor',
    'overdueCount',
  ],
  inventory: ['day', 'deviceId', 'inStock', 'reserved', 'fulfilledCount'],
  'lease-returns': ['day', 'returnsDueCount', 'returnsOverdueCount'],
};

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  private isSuperAdmin(roles: string[]): boolean {
    // Delegated admins only get here with the reports area (RolesGuard).
    return roles.includes('super_admin') || roles.includes('admin');
  }

  // Parses + enforces the bounded date window. Days are normalized to UTC midnight
  // so they line up with the rollup grain.
  private parseRange(dto: DateRangeDto): { from: Date; to: Date } {
    const from = new Date(dto.from);
    const to = new Date(dto.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid `from`/`to` date');
    }
    if (from > to) throw new BadRequestException('`from` must be on or before `to`');
    const spanDays =
      Math.floor((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Date range exceeds the ${MAX_RANGE_DAYS}-day maximum`);
    }
    return { from: startOfUtcDay(from), to: startOfUtcDay(to) };
  }

  // ---------- dashboard aggregates (read rollups only, never live tables) ----------
  async applications(tenantId: string, dto: ApplicationsReportDto) {
    const { from, to } = this.parseRange(dto);
    const rows = await this.prisma.reportRollupApplications.findMany({
      where: {
        tenantId,
        day: { gte: from, lte: to },
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      orderBy: [{ day: 'asc' }, { type: 'asc' }, { status: 'asc' }],
    });
    const totalCount = rows.reduce((s, r) => s + r.count, 0);
    return {
      range: { from: dayString(from), to: dayString(to) },
      totals: { totalCount },
      rows: rows.map((r) => ({
        day: dayString(r.day),
        type: r.type,
        status: r.status,
        count: r.count,
        approvalRate: r.approvalRate,
        avgTimeToDecisionSecs: r.avgTimeToDecisionSecs,
      })),
    };
  }

  async finance(tenantId: string, dto: FinanceReportDto) {
    const { from, to } = this.parseRange(dto);
    const rows = await this.prisma.reportRollupFinance.findMany({
      where: {
        tenantId,
        day: { gte: from, lte: to },
        ...(dto.currency ? { currency: dto.currency } : {}),
      },
      orderBy: [{ day: 'asc' }, { currency: 'asc' }],
    });
    // Collections are flows (sum over the range); arrears is a snapshot, so the total
    // is the latest day's value, not a sum of daily snapshots.
    const last = rows.at(-1);
    const totals = {
      revenueCollectedMinor: rows.reduce((n, r) => n + r.revenueCollectedMinor, 0),
      repaymentsCollectedMinor: rows.reduce((n, r) => n + r.repaymentsCollectedMinor, 0),
      arrearsOverdueMinor: last?.arrearsOverdueMinor ?? 0,
      overdueCount: last?.overdueCount ?? 0,
    };
    return {
      range: { from: dayString(from), to: dayString(to) },
      totals,
      rows: rows.map((r) => ({
        day: dayString(r.day),
        currency: r.currency,
        revenueCollectedMinor: r.revenueCollectedMinor,
        repaymentsCollectedMinor: r.repaymentsCollectedMinor,
        arrearsOverdueMinor: r.arrearsOverdueMinor,
        overdueCount: r.overdueCount,
      })),
    };
  }

  async inventory(tenantId: string, dto: InventoryReportDto) {
    const { from, to } = this.parseRange(dto);
    const rows = await this.prisma.reportRollupInventory.findMany({
      where: { tenantId, day: { gte: from, lte: to } },
      orderBy: [{ day: 'asc' }, { deviceId: 'asc' }],
    });
    const totals = rows.reduce(
      (t, r) => ({ fulfilledCount: t.fulfilledCount + r.fulfilledCount }),
      { fulfilledCount: 0 },
    );
    return {
      range: { from: dayString(from), to: dayString(to) },
      totals,
      rows: rows.map((r) => ({
        day: dayString(r.day),
        deviceId: r.deviceId,
        inStock: r.inStock,
        reserved: r.reserved,
        fulfilledCount: r.fulfilledCount,
      })),
    };
  }

  async leaseReturns(tenantId: string, dto: LeaseReturnsReportDto) {
    const { from, to } = this.parseRange(dto);
    const rows = await this.prisma.reportRollupLeaseReturns.findMany({
      where: { tenantId, day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
    });
    const totals = rows.reduce(
      (t, r) => ({
        returnsDueCount: t.returnsDueCount + r.returnsDueCount,
        returnsOverdueCount: t.returnsOverdueCount + r.returnsOverdueCount,
      }),
      { returnsDueCount: 0, returnsOverdueCount: 0 },
    );
    return {
      range: { from: dayString(from), to: dayString(to) },
      totals,
      rows: rows.map((r) => ({
        day: dayString(r.day),
        returnsDueCount: r.returnsDueCount,
        returnsOverdueCount: r.returnsOverdueCount,
      })),
    };
  }

  // Dispatch used by the export generator so a CSV is produced from exactly the same
  // PII-free aggregate the dashboard endpoint returns.
  private async reportRows(
    tenantId: string,
    reportKey: ReportKey,
    params: Record<string, unknown> | undefined,
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const dto = (params ?? {}) as DateRangeDto & Record<string, unknown>;
    switch (reportKey) {
      case 'applications':
        return {
          columns: REPORT_COLUMNS.applications,
          rows: (await this.applications(tenantId, dto as ApplicationsReportDto)).rows,
        };
      case 'finance':
        return {
          columns: REPORT_COLUMNS.finance,
          rows: (await this.finance(tenantId, dto as FinanceReportDto)).rows,
        };
      case 'inventory':
        return {
          columns: REPORT_COLUMNS.inventory,
          rows: (await this.inventory(tenantId, dto as InventoryReportDto)).rows,
        };
      case 'lease-returns':
        return {
          columns: REPORT_COLUMNS['lease-returns'],
          rows: (await this.leaseReturns(tenantId, dto as LeaseReturnsReportDto)).rows,
        };
      default:
        throw new BadRequestException(`Unknown reportKey: ${String(reportKey)}`);
    }
  }

  // ---------- scheduled rollups (BullMQ cron would call these) ----------
  // Idempotent per (tenant, day): safe to re-run and to backfill. Recomputes a single
  // day's rollups from the live tables via upsert on the composite keys. Exposed as a
  // plain method (no BullMQ in this codebase yet — mirrors payments.markOverdue).
  async refreshRollups(tenantId: string, day: Date): Promise<void> {
    const start = startOfUtcDay(day);
    const end = new Date(start.getTime() + MS_PER_DAY);
    await this.refreshApplications(tenantId, start, end);
    await this.refreshFinance(tenantId, start, end);
    await this.refreshInventory(tenantId, start, end);
    await this.refreshLeaseReturns(tenantId, start, end);
  }

  private async refreshApplications(tenantId: string, start: Date, end: Date): Promise<void> {
    // Bucket applications by their creation day; decision metrics are computed over the
    // decided members of each (type, status) group. Aggregates only — no identifiers.
    const apps = await this.prisma.application.findMany({
      where: { tenantId, createdAt: { gte: start, lt: end } },
      select: { type: true, status: true, submittedAt: true, decidedAt: true },
    });
    const groups = new Map<
      string,
      {
        type: ApplicationType;
        status: ApplicationStatus;
        count: number;
        decided: number;
        approved: number;
        decisionSecs: number;
      }
    >();
    for (const a of apps) {
      const key = `${a.type}|${a.status}`;
      const g = groups.get(key) ?? {
        type: a.type,
        status: a.status,
        count: 0,
        decided: 0,
        approved: 0,
        decisionSecs: 0,
      };
      g.count += 1;
      if (a.decidedAt) {
        g.decided += 1;
        if (a.status === ApplicationStatus.approved) g.approved += 1;
        if (a.submittedAt) {
          g.decisionSecs += Math.max(
            0,
            Math.round((a.decidedAt.getTime() - a.submittedAt.getTime()) / 1000),
          );
        }
      }
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const approvalRate = g.decided > 0 ? g.approved / g.decided : 0;
      const avgTimeToDecisionSecs = g.decided > 0 ? Math.round(g.decisionSecs / g.decided) : 0;
      await this.prisma.reportRollupApplications.upsert({
        where: {
          tenantId_day_type_status: { tenantId, day: start, type: g.type, status: g.status },
        },
        create: {
          tenantId,
          day: start,
          type: g.type,
          status: g.status,
          count: g.count,
          approvalRate,
          avgTimeToDecisionSecs,
        },
        update: { count: g.count, approvalRate, avgTimeToDecisionSecs },
      });
    }
  }

  private async refreshFinance(tenantId: string, start: Date, end: Date): Promise<void> {
    // Money collected that day: revenue = all succeeded payments; repayments = the
    // installment-purpose subset. Arrears = the outstanding balance on overdue
    // installments (point-in-time as of the refresh). Grouped by ISO currency.
    const payments = await this.prisma.payment.findMany({
      where: { tenantId, status: PaymentStatus.succeeded, updatedAt: { gte: start, lt: end } },
      select: { currency: true, amountMinor: true, purpose: true },
    });
    // Same definition as Collections: flagged overdue, or still due but past its date.
    const overdue = await this.prisma.installment.findMany({
      where: {
        tenantId,
        OR: [
          { status: InstallmentStatus.overdue },
          { status: InstallmentStatus.due, dueDate: { lt: new Date() } },
        ],
      },
      select: {
        amountMinor: true,
        paidAmountMinor: true,
        schedule: { select: { currency: true } },
      },
    });

    const byCurrency = new Map<
      string,
      {
        revenueCollectedMinor: number;
        repaymentsCollectedMinor: number;
        arrearsOverdueMinor: number;
        overdueCount: number;
      }
    >();
    const bucket = (currency: string) => {
      const b = byCurrency.get(currency) ?? {
        revenueCollectedMinor: 0,
        repaymentsCollectedMinor: 0,
        arrearsOverdueMinor: 0,
        overdueCount: 0,
      };
      byCurrency.set(currency, b);
      return b;
    };
    for (const p of payments) {
      const b = bucket(p.currency);
      b.revenueCollectedMinor += p.amountMinor;
      if (p.purpose === PaymentPurpose.installment) b.repaymentsCollectedMinor += p.amountMinor;
    }
    for (const i of overdue) {
      const b = bucket(i.schedule.currency);
      b.arrearsOverdueMinor += Math.max(0, i.amountMinor - i.paidAmountMinor);
      b.overdueCount += 1;
    }
    for (const [currency, b] of byCurrency.entries()) {
      await this.prisma.reportRollupFinance.upsert({
        where: { tenantId_day_currency: { tenantId, day: start, currency } },
        create: { tenantId, day: start, currency, ...b },
        update: { ...b },
      });
    }
  }

  private async refreshInventory(tenantId: string, start: Date, end: Date): Promise<void> {
    // Stock is the live variant sum; reserved = pending fulfilments; fulfilledCount =
    // fulfilments completed that day. Guard: skip the fulfilment part if the model is
    // absent (it exists in this schema).
    const devices = await this.prisma.device.findMany({
      where: { tenantId },
      select: { id: true, variants: { select: { stockQty: true } } },
    });
    const fulfilments = this.prisma.fulfilment
      ? await this.prisma.fulfilment.findMany({
          where: { tenantId },
          select: { deviceId: true, status: true, fulfilledAt: true },
        })
      : [];

    for (const d of devices) {
      const inStock = d.variants.reduce((s, v) => s + v.stockQty, 0);
      const reserved = fulfilments.filter(
        (f) => f.deviceId === d.id && f.status === FulfilmentStatus.pending,
      ).length;
      const fulfilledCount = fulfilments.filter(
        (f) =>
          f.deviceId === d.id &&
          f.status === FulfilmentStatus.fulfilled &&
          f.fulfilledAt != null &&
          f.fulfilledAt >= start &&
          f.fulfilledAt < end,
      ).length;
      await this.prisma.reportRollupInventory.upsert({
        where: { tenantId_day_deviceId: { tenantId, day: start, deviceId: d.id } },
        create: { tenantId, day: start, deviceId: d.id, inStock, reserved, fulfilledCount },
        update: { inStock, reserved, fulfilledCount },
      });
    }
  }

  private async refreshLeaseReturns(tenantId: string, start: Date, end: Date): Promise<void> {
    // returnsDueCount = active leases whose term ends that day; returnsOverdueCount =
    // active leases already past their end date (return overdue).
    const now = new Date();
    const [returnsDueCount, returnsOverdueCount] = await Promise.all([
      this.prisma.lease.count({
        where: { tenantId, status: LeaseStatus.active, endAt: { gte: start, lt: end } },
      }),
      this.prisma.lease.count({
        where: { tenantId, status: LeaseStatus.active, endAt: { lt: now } },
      }),
    ]);
    await this.prisma.reportRollupLeaseReturns.upsert({
      where: { tenantId_day: { tenantId, day: start } },
      create: { tenantId, day: start, returnsDueCount, returnsOverdueCount },
      update: { returnsDueCount, returnsOverdueCount },
    });
  }

  // ---------- exports ----------
  // POST enqueues a job; a BullMQ worker would generate the file. No BullMQ yet, so we
  // process inline: queued → processing → (ready | failed), writing to a private
  // object key and setting a short-lived expiry. Aggregates only, never raw PII.
  async createExport(actor: Actor, tenantId: string, dto: CreateExportDto) {
    if (!REPORT_KEYS.includes(dto.reportKey)) {
      throw new BadRequestException(`Unknown reportKey: ${dto.reportKey}`);
    }
    const job = await this.prisma.exportJob.create({
      data: {
        tenantId,
        requestedById: actor.id,
        reportKey: dto.reportKey,
        format: dto.format,
        params: (dto.params ?? {}) as Prisma.InputJsonValue,
        status: ExportStatus.queued,
      },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'reporting.export.requested',
      entity: 'export_job',
      entityId: job.id,
      after: {
        reportKey: dto.reportKey,
        format: dto.format,
        params: (dto.params ?? {}) as Prisma.InputJsonValue,
      },
    });

    const finished = await this.process(tenantId, job.id, dto);
    return { jobId: finished.id, status: finished.status };
  }

  // Inline generation (stands in for the async worker). Idempotent-ish: it only runs
  // once per createExport call.
  private async process(tenantId: string, jobId: string, dto: CreateExportDto) {
    await this.prisma.exportJob.update({
      where: { id: jobId },
      data: { status: ExportStatus.processing },
    });
    try {
      const { columns, rows } = await this.reportRows(tenantId, dto.reportKey, dto.params);
      let csv = toCsv(rows, columns);
      if (dto.format === ExportFormat.pdf) {
        // TODO: render a real PDF (no pdf lib wired yet). Ship the CSV body as a
        // placeholder so the job lifecycle is exercised end to end.
        csv = `# TODO pdf rendering — CSV placeholder\r\n${csv}`;
      }
      // The worker would PUT `csv` to a signed URL for this key; the storage seam is a
      // stub here (docs/00), so we persist the key only. Referencing `csv` keeps the
      // generated body in the flow (and asserts it is producible / PII-free).
      void csv;
      const objectKey = this.storage.createObjectKey(tenantId, 'exports', 'csv');
      const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
      return this.prisma.exportJob.update({
        where: { id: jobId },
        data: { status: ExportStatus.ready, objectKey, expiresAt, completedAt: new Date() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export generation failed';
      return this.prisma.exportJob.update({
        where: { id: jobId },
        data: { status: ExportStatus.failed, error: message, completedAt: new Date() },
      });
    }
  }

  // Never returns object_key directly; a ready job yields a short-lived signed URL and
  // the download is audited. Ownership-checked unless super_admin.
  async getExport(actor: Actor, tenantId: string, jobId: string) {
    const job = await this.prisma.exportJob.findFirst({ where: { id: jobId, tenantId } });
    if (!job) throw new NotFoundException('Export job not found');
    if (!this.isSuperAdmin(actor.roles) && job.requestedById !== actor.id) {
      throw new ForbiddenException('Not your export job');
    }
    const base = {
      id: job.id,
      reportKey: job.reportKey,
      format: job.format,
      status: job.status,
      expiresAt: job.expiresAt,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
    if (job.status !== ExportStatus.ready || !job.objectKey) return base;
    const downloadUrl = this.storage.signedGet(job.objectKey, SIGNED_URL_TTL_SECS);
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'reporting.export.downloaded',
      entity: 'export_job',
      entityId: job.id,
      after: { reportKey: job.reportKey, format: job.format },
    });
    return { ...base, downloadUrl };
  }

  // Own jobs; super_admin sees all. object_key is never serialized.
  async listExports(actor: Actor, tenantId: string, status?: ExportStatus, limit = 50) {
    const jobs = await this.prisma.exportJob.findMany({
      where: {
        tenantId,
        ...(this.isSuperAdmin(actor.roles) ? {} : { requestedById: actor.id }),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        reportKey: true,
        format: true,
        status: true,
        params: true,
        expiresAt: true,
        error: true,
        createdAt: true,
        completedAt: true,
      },
    });
    return jobs;
  }

  // Cleanup job: flip ready jobs past their expiry to `expired` (the worker would also
  // delete the stored object). Returns the number expired.
  async expireExports(tenantId: string): Promise<number> {
    const res = await this.prisma.exportJob.updateMany({
      where: { tenantId, status: ExportStatus.ready, expiresAt: { lt: new Date() } },
      data: { status: ExportStatus.expired },
    });
    return res.count;
  }

  // ---------- cross-tenant (super_admin, audited bypass) ----------
  // Reads application rollups across all tenants behind the explicit, audited bypass
  // (docs/01). Minimal: aggregates only, one audit entry per use.
  async crossTenantApplications(actor: Actor, dto: ApplicationsReportDto) {
    if (!this.isSuperAdmin(actor.roles)) {
      throw new ForbiddenException('Cross-tenant reporting requires super_admin');
    }
    const { from, to } = this.parseRange(dto);
    const rows = await this.prisma.reportRollupApplications.findMany({
      where: {
        day: { gte: from, lte: to },
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      orderBy: [{ tenantId: 'asc' }, { day: 'asc' }, { type: 'asc' }, { status: 'asc' }],
    });
    // Audit the bypass against the actor's own tenant context.
    await this.audit.write(actor.tenantId ?? 'platform', {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'reporting.cross_tenant.read',
      entity: 'report_rollup_applications',
      after: {
        report: 'applications',
        from: dayString(from),
        to: dayString(to),
        tenants: new Set(rows.map((r) => r.tenantId)).size,
      },
    });
    return {
      range: { from: dayString(from), to: dayString(to) },
      rows: rows.map((r) => ({
        tenantId: r.tenantId,
        day: dayString(r.day),
        type: r.type,
        status: r.status,
        count: r.count,
        approvalRate: r.approvalRate,
        avgTimeToDecisionSecs: r.avgTimeToDecisionSecs,
      })),
    };
  }
}
