// Deterministic, integer-only installment math. One implementation, covered by
// finance.calculator.spec.ts. No floats leak out — all outputs are minor units.
// Percentages/rates are integer basis points (bps): 2000 bps = 20%.
export interface InstallmentInput {
  cashPriceMinor: number;
  depositPctBps: number;
  months: number;
  monthlyMarkupBps: number;
}

export interface Installment {
  depositMinor: number;
  financedMinor: number;
  totalMarkupMinor: number;
  totalRepayableMinor: number; // financed + markup
  monthlyMinor: number; // regular instalment (months - 1 of these)
  finalMonthlyMinor: number; // absorbs the rounding remainder
  totalPayableMinor: number; // deposit + totalRepayable
}

// round-half-up for non-negative inputs (Math.round rounds .5 toward +Infinity).
function round(n: number): number {
  return Math.round(n);
}

export function computeInstallment(i: InstallmentInput): Installment {
  const depositMinor = round((i.cashPriceMinor * i.depositPctBps) / 10000);
  const financedMinor = i.cashPriceMinor - depositMinor;
  const totalMarkupMinor = round((financedMinor * i.monthlyMarkupBps * i.months) / 10000);
  const totalRepayableMinor = financedMinor + totalMarkupMinor;
  const monthlyMinor = Math.ceil(totalRepayableMinor / i.months);
  const finalMonthlyMinor = totalRepayableMinor - monthlyMinor * (i.months - 1);
  return {
    depositMinor,
    financedMinor,
    totalMarkupMinor,
    totalRepayableMinor,
    monthlyMinor,
    finalMonthlyMinor,
    totalPayableMinor: depositMinor + totalRepayableMinor,
  };
}

// iStore FLEX rule (the website's plan maths, docs/04 + docs/15): the fee is a flat %
// of the CASH price with a minimum, independent of how much is paid upfront.
export interface FlatInstallmentInput {
  cashPriceMinor: number;
  months: number;
  premiumBps: number; // e.g. 700 = 7%
  minPremiumMinor: number; // e.g. GMD 2,000.00 = 200000
  depositMinor: number; // what the customer pays today (plan deposit or custom upfront)
}

export function computeFlatInstallment(i: FlatInstallmentInput): Installment {
  const totalMarkupMinor = Math.max(
    round((i.cashPriceMinor * i.premiumBps) / 10000),
    i.minPremiumMinor,
  );
  const depositMinor = i.depositMinor;
  const financedMinor = i.cashPriceMinor - depositMinor;
  const totalRepayableMinor = financedMinor + totalMarkupMinor;
  const monthlyMinor = Math.ceil(totalRepayableMinor / i.months);
  const finalMonthlyMinor = totalRepayableMinor - monthlyMinor * (i.months - 1);
  return {
    depositMinor,
    financedMinor,
    totalMarkupMinor,
    totalRepayableMinor,
    monthlyMinor,
    finalMonthlyMinor,
    totalPayableMinor: depositMinor + totalRepayableMinor,
  };
}

// Customer-chosen upfront must stay within 20–80% of the cash price (website rule).
export const MIN_UPFRONT_BPS = 2000;
export const MAX_UPFRONT_BPS = 8000;
export function upfrontInRange(cashPriceMinor: number, upfrontMinor: number): boolean {
  return (
    upfrontMinor >= Math.round((cashPriceMinor * MIN_UPFRONT_BPS) / 10000) &&
    upfrontMinor <= Math.round((cashPriceMinor * MAX_UPFRONT_BPS) / 10000)
  );
}
