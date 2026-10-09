import { convertMinor, minorRatePpm } from './clone.math';

describe('catalog clone math', () => {
  it('GMD → LRD at 2.7, step LRD 500 (both 2 decimals)', () => {
    // GMD 60,000.00 → LRD 162,000.00
    expect(convertMinor(6_000_000, 2_700_000, 50_000)).toBe(16_200_000);
  });

  it('GMD → SLE at 0.32, step SLE 100', () => {
    // GMD 23,000 × 0.32 = 7,360 → 7,400 (half-up to the 100 step)
    expect(convertMinor(2_300_000, 320_000, 10_000)).toBe(740_000);
  });

  it('GMD (2 decimals) → GNF (0 decimals) at 122, step GNF 10,000', () => {
    const ppm = minorRatePpm(122_000_000, 2, 0); // per minor unit: 1.22 GNF per butut
    expect(ppm).toBe(1_220_000);
    // GMD 60,000.00 = 6,000,000 bututs → GNF 7,320,000
    expect(convertMinor(6_000_000, ppm, 10_000)).toBe(7_320_000);
  });

  it('rounds half-up to the step', () => {
    expect(convertMinor(150, 1_000_000, 100)).toBe(200);
    expect(convertMinor(149, 1_000_000, 100)).toBe(100);
  });

  it('converts the FLEX minimum fees', () => {
    expect(convertMinor(200_000, 2_700_000, 50_000)).toBe(550_000); // D2,000 → L$5,400 → 5,500
    expect(convertMinor(350_000, 2_700_000, 50_000)).toBe(950_000); // D3,500 → L$9,450 → 9,500
  });

  it('rejects floats and bad params', () => {
    expect(() => convertMinor(1.5, 1_000_000, 1)).toThrow();
    expect(() => convertMinor(100, 0, 1)).toThrow();
    expect(() => convertMinor(100, 1, 0)).toThrow();
  });
});
