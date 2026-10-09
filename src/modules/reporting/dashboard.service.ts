import { Injectable } from '@nestjs/common';
import { currencyOf } from '../../common/tenancy/currency';
import {
  ApplicationStatus,
  ApplicationType,
  InstallmentStatus,
  PaymentPurpose,
  PaymentStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

// Aggregates for the admin portal home screen. Tenant-scoped (the portal sends
// X-Tenant). Kept to a handful of bounded queries; heavy reporting lives in
// ReportingService with its own audited, super-admin path.
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const currency = currencyOf(tenant);

    const [byStatus, byType, outstanding, overdue, inspections, trendRows, feedRows] =
      await Promise.all([
        this.prisma.application.groupBy({
          by: ['status'],
          where: { tenantId },
          _count: { _all: true },
        }),
        this.prisma.application.groupBy({
          by: ['type'],
          where: { tenantId },
          _count: { _all: true },
        }),
        // Outstanding balance across not-yet-settled installments.
        this.prisma.installment.aggregate({
          where: { tenantId, status: { in: [InstallmentStatus.due, InstallmentStatus.overdue] } },
          _sum: { amountMinor: true, paidAmountMinor: true },
        }),
        this.prisma.installment.aggregate({
          where: { tenantId, status: InstallmentStatus.overdue },
          _sum: { amountMinor: true, paidAmountMinor: true },
        }),
        this.prisma.fulfilment.count({ where: { tenantId, status: 'pending' } }),
        // Last 7 days of payment activity — succeeded feeds the repayments line,
        // failed/reversed feed the overdue/defaults line.
        this.prisma.payment.findMany({
          where: {
            tenantId,
            purpose: PaymentPurpose.installment,
            status: { in: [PaymentStatus.succeeded, PaymentStatus.failed, PaymentStatus.reversed] },
            createdAt: { gte: daysAgo(6) },
          },
          select: { amountMinor: true, status: true, createdAt: true },
        }),
        this.prisma.auditLog.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { id: true, action: true, entity: true, actorRole: true, createdAt: true },
        }),
      ]);

    const statusCount = (statuses: Array<ApplicationStatus>) =>
      byStatus
        .filter((r) => statuses.includes(r.status))
        .reduce((sum, r) => sum + r._count._all, 0);

    const totalApplications = byStatus.reduce((sum, r) => sum + r._count._all, 0);
    const approvedApplications = statusCount([
      ApplicationStatus.approved,
      ApplicationStatus.active,
      ApplicationStatus.agreement_pending,
    ]);
    const pendingReview = statusCount([
      ApplicationStatus.submitted,
      ApplicationStatus.under_review,
      ApplicationStatus.info_requested,
    ]);
    const declined = statusCount([ApplicationStatus.declined, ApplicationStatus.withdrawn]);

    const activeRepaymentsMinor =
      (outstanding._sum.amountMinor ?? 0) - (outstanding._sum.paidAmountMinor ?? 0);
    const overduePaymentsMinor =
      (overdue._sum.amountMinor ?? 0) - (overdue._sum.paidAmountMinor ?? 0);

    const typeLabels: Record<ApplicationType, string> = {
      [ApplicationType.financing]: 'Financing',
      [ApplicationType.lease]: 'Lease',
      [ApplicationType.trade_in]: 'Trade-In',
    };
    const assetTypeDistribution = byType.map((r) => ({
      name: typeLabels[r.type],
      value: r._count._all,
    }));

    const applicationByStatus = [
      { status: 'Approved', count: approvedApplications },
      { status: 'Pending', count: pendingReview },
      { status: 'Declined', count: declined },
    ];

    // Bucket payments into the last 7 days (major units): succeeded → repayments,
    // failed/reversed → defaults (overdue payments).
    const repaymentsTrend = last7Days().map((day) => {
      const dayPayments = trendRows.filter((p) => sameDay(p.createdAt, day.date));
      const repayments =
        dayPayments
          .filter((p) => p.status === PaymentStatus.succeeded)
          .reduce((s, p) => s + p.amountMinor, 0) / 100;
      const defaults =
        dayPayments
          .filter((p) => p.status !== PaymentStatus.succeeded)
          .reduce((s, p) => s + p.amountMinor, 0) / 100;
      return {
        label: day.label,
        repayments: Math.round(repayments),
        defaults: Math.round(defaults),
      };
    });

    const feed = feedRows.map((r) => ({
      id: r.id,
      kind: feedKind(r.entity),
      message: `${prettyRole(r.actorRole)} ${prettyAction(r.action)} ${prettyEntity(r.entity)}`,
      at: r.createdAt.toISOString(),
    }));

    return {
      stats: {
        totalApplications,
        approvedApplications,
        pendingReview,
        inspectionsScheduled: inspections,
        activeRepaymentsMinor,
        overduePaymentsMinor,
        currency,
        lastUpdated: new Date().toISOString(),
      },
      assetTypeDistribution,
      applicationByStatus,
      repaymentsTrend,
      feed,
    };
  }
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function last7Days(): Array<{ date: Date; label: string }> {
  const out: Array<{ date: Date; label: string }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push({ date: d, label: d.toLocaleDateString('en-US', { weekday: 'short' }) });
  }
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function feedKind(entity: string): string {
  const e = entity.toLowerCase();
  if (e.includes('application')) return 'application';
  if (e.includes('payment') || e.includes('installment')) return 'payment';
  if (e.includes('fulfil') || e.includes('inspection')) return 'inspection';
  if (e.includes('user') || e.includes('staff')) return 'user';
  return 'system';
}

function prettyRole(role?: string | null): string {
  if (!role) return 'System';
  return role
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function prettyAction(action: string): string {
  return action.replace(/[._]/g, ' ').toLowerCase();
}

function prettyEntity(entity: string): string {
  return entity.replace(/[._]/g, ' ').toLowerCase();
}
