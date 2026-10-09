// Deterministic, integer-only monthly lease-fee math. A term is priced either by a
// fixed fee (monthlyFeeMinor) or as basis points of the cash price (monthlyFeeBps) —
// exactly one. No floats leak out; all outputs are minor units. (docs/05)
export const LEASE_TERMS = [6, 12] as const;
export type LeaseMonths = (typeof LEASE_TERMS)[number];

export interface LeaseFeeInput {
  cashPriceMinor: number;
  monthlyFeeBps?: number | null;
  monthlyFeeMinor?: number | null;
}

// round-half-up for non-negative inputs (Math.round rounds .5 toward +Infinity).
function round(n: number): number {
  return Math.round(n);
}

export function isLeaseTerm(months: number): months is LeaseMonths {
  return (LEASE_TERMS as readonly number[]).includes(months);
}

// Resolves a term's monthly fee. Throws if a term defines neither (or both) inputs,
// so misconfiguration fails loudly rather than pricing to zero.
export function computeMonthlyFee(i: LeaseFeeInput): number {
  const hasFixed = i.monthlyFeeMinor != null;
  const hasBps = i.monthlyFeeBps != null;
  if (hasFixed === hasBps) {
    throw new Error('Lease term must define exactly one of monthlyFeeMinor / monthlyFeeBps');
  }
  if (hasFixed) return i.monthlyFeeMinor as number;
  return round((i.cashPriceMinor * (i.monthlyFeeBps as number)) / 10000);
}
