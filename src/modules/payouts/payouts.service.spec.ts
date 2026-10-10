import { shareOf } from './payouts.service';

describe('shareOf', () => {
  it('takes basis points of a price, rounding down', () => {
    expect(shareOf(10_500_000, 150)).toBe(157_500); // 1.5% of GMD 105,000
    expect(shareOf(999, 250)).toBe(24);
    expect(shareOf(10_000, 0)).toBe(0);
  });
});
