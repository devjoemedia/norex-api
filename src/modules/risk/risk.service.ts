import { Injectable, Logger } from '@nestjs/common';
import { InstallmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { KycService } from '../kyc/kyc.service';

// Rule-based risk checks on each application (docs/26). They don't decide anything:
// they put what a reviewer should look at first in front of them. Stored on the
// application when it's submitted, and recomputed on demand.

export type Severity = 'high' | 'medium' | 'info';
export interface RiskFlag {
  code: string;
  severity: Severity;
  label: string;
  detail: string;
}

const DAY = 86_400_000;
/** Share of monthly income the plan's payment may take before it's flagged. */
export const AFFORDABILITY = { medium: 0.35, high: 0.5 };

/** Income in minor units per month, from an amount and how often it's earned. */
export function monthlyIncomeMinor(
  amount: unknown,
  frequency: unknown,
  minorDigits = 2,
): number | null {
  const n = Number(String(amount ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const per = String(frequency ?? 'monthly').toLowerCase();
  const factor = per.startsWith('week') ? 52 / 12 : per.startsWith('da') ? 26 : 1;
  return Math.round(n * factor * 10 ** minorDigits);
}

/** The plan's payment per month, whatever the repayment frequency. */
export function monthlyPaymentMinor(snapshot: Record<string, unknown> | null): number | null {
  if (!snapshot) return null;
  const freq = String(snapshot.frequency ?? 'monthly');
  const period = Number(snapshot.periodMinor ?? 0);
  if (period > 0 && freq !== 'monthly') {
    return Math.round(period * (freq === 'weekly' ? 52 / 12 : 26 / 12));
  }
  const monthly = Number(snapshot.monthlyMinor ?? 0);
  return monthly > 0 ? monthly : null;
}

export function affordabilityFlag(
  paymentMinor: number | null,
  incomeMinor: number | null,
): RiskFlag | null {
  if (paymentMinor === null) return null;
  if (incomeMinor === null) {
    return {
      code: 'income_missing',
      severity: 'medium',
      label: 'No income given',
      detail: 'Ask for their income before approving.',
    };
  }
  const share = paymentMinor / incomeMinor;
  if (share < AFFORDABILITY.medium) return null;
  return {
    code: 'high_payment_to_income',
    severity: share >= AFFORDABILITY.high ? 'high' : 'medium',
    label: 'Payment is a big share of income',
    detail: `The payment is ${Math.round(share * 100)}% of the income they gave.`,
  };
}

export function riskLevel(flags: RiskFlag[]): 'high' | 'medium' | 'low' {
  if (flags.some((f) => f.severity === 'high')) return 'high';
  if (flags.some((f) => f.severity === 'medium')) return 'medium';
  return 'low';
}

@Injectable()
export class RiskService {
  private readonly log = new Logger('Risk');

  constructor(
    private readonly prisma: PrismaService,
    private readonly kyc: KycService,
  ) {}

  /** Runs the checks for one application and saves the result. Never throws. */
  async assess(tenantId: string, applicationId: string): Promise<RiskFlag[]> {
    try {
      const flags = await this.flagsFor(tenantId, applicationId);
      await this.prisma.application.update({
        where: { id: applicationId },
        data: {
          riskFlags: flags as unknown as Prisma.InputJsonValue,
          riskLevel: riskLevel(flags),
        },
      });
      return flags;
    } catch (e) {
      this.log.warn(`risk check failed for ${applicationId}: ${(e as Error).message}`);
      return [];
    }
  }

  private async flagsFor(tenantId: string, applicationId: string): Promise<RiskFlag[]> {
    const app = await this.prisma.application.findFirst({ where: { tenantId, id: applicationId } });
    if (!app) return [];
    const now = Date.now();
    const [tenant, kyc, recent, overdue, activePlans, declined] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.kycProfile.findFirst({ where: { tenantId, customerId: app.customerId } }),
      this.prisma.application.count({
        where: {
          tenantId,
          customerId: app.customerId,
          id: { not: app.id },
          createdAt: { gte: new Date(now - 7 * DAY) },
        },
      }),
      this.prisma.installment.count({
        where: {
          tenantId,
          status: InstallmentStatus.overdue,
          schedule: { customerId: app.customerId, applicationId: { not: app.id } },
        },
      }),
      this.prisma.repaymentSchedule.count({
        where: {
          tenantId,
          customerId: app.customerId,
          status: 'active',
          applicationId: { not: app.id },
        },
      }),
      this.prisma.application.count({
        where: {
          tenantId,
          customerId: app.customerId,
          id: { not: app.id },
          status: 'declined',
          decidedAt: { gte: new Date(now - 30 * DAY) },
        },
      }),
    ]);
    const flags: RiskFlag[] = [];

    if (app.type !== 'trade_in') {
      const employment = kyc?.employmentCipher
        ? this.kyc.openJson<Record<string, unknown>>(kyc.employmentCipher)
        : null;
      const income = monthlyIncomeMinor(
        employment?.monthlyIncome,
        employment?.incomeFrequency,
        tenant?.minorUnitDigits ?? 2,
      );
      const payment = monthlyPaymentMinor(app.planSnapshot as Record<string, unknown> | null);
      const f = affordabilityFlag(payment, income);
      if (f) flags.push(f);
    }
    if (overdue > 0) {
      flags.push({
        code: 'existing_arrears',
        severity: 'high',
        label: 'Behind on another plan',
        detail: `${overdue} overdue payment${overdue === 1 ? '' : 's'} on an existing plan.`,
      });
    }
    if (activePlans >= 2) {
      flags.push({
        code: 'many_active_plans',
        severity: 'medium',
        label: 'Already has plans running',
        detail: `${activePlans} active plans already.`,
      });
    }
    if (recent >= 2) {
      flags.push({
        code: 'repeat_applications',
        severity: 'medium',
        label: 'Several applications this week',
        detail: `${recent} other applications in the last 7 days.`,
      });
    }
    if (declined > 0) {
      flags.push({
        code: 'recently_declined',
        severity: 'medium',
        label: 'Declined recently',
        detail: 'Another application was declined in the last 30 days.',
      });
    }
    if (kyc?.status === 'rejected') {
      flags.push({
        code: 'kyc_rejected',
        severity: 'high',
        label: 'ID check was rejected',
        detail: kyc.rejectReason ?? 'Their identity check was rejected before.',
      });
    }
    return flags;
  }
}
