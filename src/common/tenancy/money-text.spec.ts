import { formatAmount } from './money-text';

describe('formatAmount', () => {
  it('uses each currency’s decimals', () => {
    expect(formatAmount(8708, 'GMD')).toBe('87.08');
    expect(formatAmount(7_320_000, 'GNF')).toBe('7,320,000');
    expect(formatAmount(16_200_000, 'LRD')).toBe('162,000.00');
  });
});
