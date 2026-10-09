import { computeMonthlyFee, isLeaseTerm, LEASE_TERMS } from './lease.calculator';

describe('lease fee calculator', () => {
  it('restricts terms to the 6/12 allow-list', () => {
    expect(LEASE_TERMS).toEqual([6, 12]);
    expect(isLeaseTerm(6)).toBe(true);
    expect(isLeaseTerm(12)).toBe(true);
    expect(isLeaseTerm(9)).toBe(false);
    expect(isLeaseTerm(0)).toBe(false);
  });

  it('prices a bps term as an integer of cash price', () => {
    // 9% of 100_000 = 9_000
    expect(computeMonthlyFee({ cashPriceMinor: 100_000, monthlyFeeBps: 900 })).toBe(9_000);
  });

  it('rounds bps results to whole minor units (no floats)', () => {
    const fee = computeMonthlyFee({ cashPriceMinor: 99_999, monthlyFeeBps: 617 });
    expect(Number.isInteger(fee)).toBe(true);
  });

  it('returns the fixed fee verbatim', () => {
    expect(computeMonthlyFee({ cashPriceMinor: 100_000, monthlyFeeMinor: 4_500 })).toBe(4_500);
  });

  it('throws when a term defines neither fee input', () => {
    expect(() => computeMonthlyFee({ cashPriceMinor: 100_000 })).toThrow();
  });

  it('throws when a term defines both fee inputs', () => {
    expect(() =>
      computeMonthlyFee({ cashPriceMinor: 100_000, monthlyFeeBps: 900, monthlyFeeMinor: 4_500 }),
    ).toThrow();
  });

  it('is deterministic', () => {
    const a = computeMonthlyFee({ cashPriceMinor: 123_456, monthlyFeeBps: 725 });
    const b = computeMonthlyFee({ cashPriceMinor: 123_456, monthlyFeeBps: 725 });
    expect(a).toBe(b);
  });
});
