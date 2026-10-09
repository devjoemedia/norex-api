// Deterministic repayment-schedule generator. Turns an application's immutable plan
// snapshot (docs/04 financing, docs/05 lease) into a set of installments. All money is
// integer minor units; no floats. The schedule is built once at activation and never
// recomputed from the live catalog (docs/09).

export interface ScheduleInput {
  kind: 'financing' | 'lease';
  currency: string;
  months: number;
  depositMinor: number; // 0 for lease
  monthlyMinor: number; // regular monthly instalment
  finalMonthlyMinor: number; // last instalment (absorbs rounding remainder)
  activatedAt: Date;
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

  for (let i = 1; i <= input.months; i++) {
    installments.push({
      seq: i,
      isDeposit: false,
      dueDate: addMonths(input.activatedAt, i),
      amountMinor: i === input.months ? input.finalMonthlyMinor : input.monthlyMinor,
    });
  }

  const totalAmountMinor = installments.reduce((sum, x) => sum + x.amountMinor, 0);
  return { currency: input.currency, totalAmountMinor, installments };
}
