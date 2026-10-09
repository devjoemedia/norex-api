import { computeFlatInstallment, upfrontInRange } from './finance.calculator';

// Golden values from iStore-Price-Lock.xlsm ("LOCK + FLEX": Price Used, Pay Today 20%,
// 3M Total, 6M Total). GMD amounts × 100 = minor units.
const EXCEL: Array<[price: number, total3: number, total6: number]> = [
  [23000, 25000, 26500], // iPhone 13 128GB — both minimums apply (2,000 / 3,500)
  [28000, 30000, 31640], // iPhone 13 256GB — 3M minimum, 6M 13%
  [60000, 64200, 67800], // iPhone 16 Pro Max 256GB
  [70000, 74900, 79100], // iPhone 16 Pro Max 1TB
  [165000, 176550, 186450], // iPhone 17 Pro Max 2TB
];

const flex = (price: number, months: 3 | 6, depositMinor?: number) =>
  computeFlatInstallment({
    cashPriceMinor: price * 100,
    months,
    premiumBps: months === 3 ? 700 : 1300,
    minPremiumMinor: months === 3 ? 200000 : 350000,
    depositMinor: depositMinor ?? price * 20,
  });

describe('FLEX flat-on-cash calculator (matches the Excel price lock)', () => {
  it.each(EXCEL)('GMD %i → 3M total %i, 6M total %i', (price, total3, total6) => {
    expect(flex(price, 3).totalPayableMinor).toBe(total3 * 100);
    expect(flex(price, 6).totalPayableMinor).toBe(total6 * 100);
  });

  it('iPhone 16 Pro Max 256GB over 6 months: GMD 12,000 today + GMD 9,300 × 6', () => {
    const r = flex(60000, 6);
    expect(r.depositMinor).toBe(1_200_000);
    expect(r.monthlyMinor).toBe(930_000);
    expect(r.finalMonthlyMinor).toBe(930_000);
  });

  it('paying more upfront lowers the monthly but not the total', () => {
    const std = flex(60000, 6);
    const custom = flex(60000, 6, 2_400_000); // 40%
    expect(custom.totalPayableMinor).toBe(std.totalPayableMinor);
    expect(custom.monthlyMinor).toBe(730_000); // (67,800 − 24,000) ÷ 6
  });

  it('instalments always sum exactly to the total (remainder in the final month)', () => {
    const r = flex(28000, 3); // 24,400 left ÷ 3 does not divide evenly
    expect(r.monthlyMinor * 2 + r.finalMonthlyMinor).toBe(r.totalRepayableMinor);
  });

  it('upfront must stay within 20–80% of the cash price', () => {
    expect(upfrontInRange(6_000_000, 1_200_000)).toBe(true);
    expect(upfrontInRange(6_000_000, 1_199_999)).toBe(false);
    expect(upfrontInRange(6_000_000, 4_800_000)).toBe(true);
    expect(upfrontInRange(6_000_000, 4_800_001)).toBe(false);
  });
});
