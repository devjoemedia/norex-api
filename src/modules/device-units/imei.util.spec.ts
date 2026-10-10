import { isValidImei, maskImei, normalizeImei } from './imei.util';

describe('imei.util', () => {
  it('accepts valid 15-digit IMEIs (Luhn)', () => {
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('35-209900-176148-1')).toBe(true);
    expect(isValidImei('356938035643809')).toBe(true);
  });

  it('rejects a wrong check digit, wrong length or letters', () => {
    expect(isValidImei('490154203237519')).toBe(false);
    expect(isValidImei('49015420323751')).toBe(false);
    expect(isValidImei('49015420323751A')).toBe(false);
  });

  it('normalizes and masks', () => {
    expect(normalizeImei('35 209900 176148-1')).toBe('352099001761481');
    expect(maskImei('1481')).toBe('•••• 1481');
  });
});
