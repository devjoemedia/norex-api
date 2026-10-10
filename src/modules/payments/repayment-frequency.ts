// How often an installment plan is repaid (docs/09). Terms are priced in months; the
// customer may instead repay the same total weekly or every two weeks. Integer minor
// units only: the final payment absorbs any rounding remainder.

export const FREQUENCIES = ['monthly', 'biweekly', 'weekly'] as const;
export type RepaymentFrequency = (typeof FREQUENCIES)[number];

const PER_YEAR: Record<RepaymentFrequency, number> = { monthly: 12, biweekly: 26, weekly: 52 };
const DAYS: Partial<Record<RepaymentFrequency, number>> = { biweekly: 14, weekly: 7 };

export function isFrequency(v: unknown): v is RepaymentFrequency {
  return typeof v === 'string' && (FREQUENCIES as readonly string[]).includes(v);
}

/** Number of payments for a term: 6 months = 6 monthly, 13 bi-weekly or 26 weekly. */
export function periodsFor(months: number, frequency: RepaymentFrequency): number {
  if (frequency === 'monthly') return months;
  return Math.max(1, Math.round((months * PER_YEAR[frequency]) / 12));
}

/** Splits a total into `periods` equal payments; the last one takes the remainder. */
export function splitTotal(totalMinor: number, periods: number) {
  const periodMinor = Math.floor(totalMinor / periods);
  return { periodMinor, finalPeriodMinor: totalMinor - periodMinor * (periods - 1) };
}

/**
 * The payment plan for a priced monthly term at another frequency. `monthly` and
 * `finalMonthly` come from the finance calculator; the deposit is never split.
 */
export function atFrequency(
  term: { months: number; monthlyMinor: number; finalMonthlyMinor: number },
  frequency: RepaymentFrequency,
) {
  if (frequency === 'monthly') {
    return {
      frequency,
      periods: term.months,
      periodMinor: term.monthlyMinor,
      finalPeriodMinor: term.finalMonthlyMinor,
    };
  }
  const total = term.monthlyMinor * (term.months - 1) + term.finalMonthlyMinor;
  const periods = periodsFor(term.months, frequency);
  return { frequency, periods, ...splitTotal(total, periods) };
}

/** The due date of payment number `i` (1-based) after `start`. */
export function dueDateFor(
  start: Date,
  frequency: RepaymentFrequency,
  i: number,
  addMonths: (d: Date, n: number) => Date,
): Date {
  const days = DAYS[frequency];
  if (!days) return addMonths(start, i);
  return new Date(start.getTime() + days * i * 24 * 60 * 60 * 1000);
}
