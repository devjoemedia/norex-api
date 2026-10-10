// Deterministic repayment-schedule generator. Turns an application's immutable plan
// snapshot (docs/04 financing, docs/05 lease) into a set of installments. All money is
// integer minor units; no floats. The schedule is built once at activation and never
// recomputed from the live catalog (docs/09).

import { RepaymentFrequency, atFrequency, dueDateFor } from './repayment-frequency';

export interface ScheduleInput {
  kind: 'financing' | 'lease';
  currency: string;
  months: number;
  depositMinor: number; // 0 for lease
  monthlyMinor: number; // regular monthly instalment
  finalMonthlyMinor: number; // last instalment (absorbs rounding remainder)
  activatedAt: Date;
  /** Installment plans only; leases are always monthly. Default monthly. */
  frequency?: RepaymentFrequency;
}

export interface BuiltInstallment {
  seq: number;
  isDeposit: boolean;
  dueDate: Date;
  amountMinor: number;
}

export interface BuiltSchedule {
  currency: string;
  totalAmountMinor: number;
  installments: BuiltInstallment[];
}

// Adds whole months to a date, clamping the day to the target month's length so
// e.g. Jan-31 + 1 month lands on the last day of February rather than overflowing.
export function addMonths(base: Date, months: number): Date {
  const d = new Date(base.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function buildSchedule(input: ScheduleInput): BuiltSchedule {
  if (input.months < 1) throw new Error('months must be >= 1');
  const installments: BuiltInstallment[] = [];

  // Financing carries an upfront deposit as seq 0, due at activation.
  if (input.kind === 'financing' && input.depositMinor > 0) {
    installments.push({
      seq: 0,
      isDeposit: true,
      dueDate: input.activatedAt,
      amountMinor: input.depositMinor,
    });
  }

  // Same total as the monthly plan, paid in more, smaller payments when not monthly.
  const frequency = input.kind === 'financing' ? (input.frequency ?? 'monthly') : 'monthly';
  const plan = atFrequency(
    {
      months: input.months,
      monthlyMinor: input.monthlyMinor,
      finalMonthlyMinor: input.finalMonthlyMinor,
    },
    frequency,
  );
  for (let i = 1; i <= plan.periods; i++) {
    installments.push({
      seq: i,
      isDeposit: false,
      dueDate: dueDateFor(input.activatedAt, frequency, i, addMonths),
      amountMinor: i === plan.periods ? plan.finalPeriodMinor : plan.periodMinor,
    });
  }

  const totalAmountMinor = installments.reduce((sum, x) => sum + x.amountMinor, 0);
  return { currency: input.currency, totalAmountMinor, installments };
}
