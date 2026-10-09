import { keyedHash, numericOtp, randomTokenHex, safeEqualHex } from './hash.util';

describe('hash.util (auth security primitives)', () => {
  it('numericOtp is the requested length and numeric', () => {
    for (let i = 0; i < 50; i++) {
      const code = numericOtp(6);
      expect(code).toHaveLength(6);
      expect(/^[0-9]{6}$/.test(code)).toBe(true);
    }
  });

  it('keyedHash is deterministic and key-dependent', () => {
    expect(keyedHash('secret', 'value')).toBe(keyedHash('secret', 'value'));
    expect(keyedHash('secret-a', 'value')).not.toBe(keyedHash('secret-b', 'value'));
    expect(keyedHash('secret', 'value-a')).not.toBe(keyedHash('secret', 'value-b'));
  });

  it('safeEqualHex matches equal hashes and rejects different / mismatched-length', () => {
    const h = keyedHash('k', 'v');
    expect(safeEqualHex(h, h)).toBe(true);
    expect(safeEqualHex(h, keyedHash('k', 'w'))).toBe(false);
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
  });

  it('randomTokenHex returns 2 hex chars per byte and is unpredictable', () => {
    expect(randomTokenHex(16)).toHaveLength(32);
    expect(randomTokenHex(32)).not.toBe(randomTokenHex(32));
  });
});
