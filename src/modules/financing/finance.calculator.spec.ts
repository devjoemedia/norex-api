import { computeInstallment } from './finance.calculator';

describe('finance calculator (deterministic, integer-only)', () => {
  it('computes a clean example', () => {
    // GMD 120,000.00 = 12,000,000 minor; 20% deposit; 6 months; 300bps markup.
    const r = computeInstallment({
      cashPriceMinor: 12_000_000,
      depositPctBps: 2000,
      months: 6,
      monthlyMarkupBps: 300,
    });
    expect(r.depositMinor).toBe(2_400_000); // 20%
    expect(r.financedMinor).toBe(9_600_000);
    expect(r.totalMarkupMinor).toBe(round((9_600_000 * 300 * 6) / 10000)); // 1,728,000
    expect(r.totalRepayableMinor).toBe(r.financedMinor + r.totalMarkupMinor);
  });

  it('the instalments sum exactly to total repayable (remainder in the final)', () => {
    const cases = [
      { cashPriceMinor: 12_345_678, depositPctBps: 1500, months: 7, monthlyMarkupBps: 275 },
      { cashPriceMinor: 9_999_999, depositPctBps: 3333, months: 3, monthlyMarkupBps: 999 },
      { cashPriceMinor: 1, depositPctBps: 5000, months: 12, monthlyMarkupBps: 100 },
      { cashPriceMinor: 55_000_000, depositPctBps: 0, months: 12, monthlyMarkupBps: 250 },
    ];
    for (const c of cases) {
      const r = computeInstallment(c);
      const sum = r.monthlyMinor * (c.months - 1) + r.finalMonthlyMinor;
      expect(sum).toBe(r.totalRepayableMinor);
      expect(r.depositMinor + sum).toBe(r.totalPayableMinor);
      // integers only
      for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true);
      // final instalment never exceeds a regular one
      expect(r.finalMonthlyMinor).toBeLessThanOrEqual(r.monthlyMinor);
    }
  });

  it('is deterministic', () => {
    const input = {
      cashPriceMinor: 7_654_321,
      depositPctBps: 2500,
      months: 9,
      monthlyMarkupBps: 180,
    };
    expect(computeInstallment(input)).toEqual(computeInstallment(input));
  });
});

function round(n: number): number {
  return Math.round(n);
}
