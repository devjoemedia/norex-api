import { authenticator } from 'otplib';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';

describe('staff 2FA crypto path', () => {
  const key = 'a-test-encryption-key-at-least-32-chars-long';

  it('secret-box round-trips and rejects a wrong key', () => {
    const secret = authenticator.generateSecret();
    const box = encryptSecret(secret, key);
    expect(box).not.toContain(secret);
    expect(decryptSecret(box, key)).toBe(secret);
    expect(() => decryptSecret(box, 'a-different-key-that-is-also-32-chars')).toThrow();
  });

  it('a TOTP generated from the secret verifies, and a wrong code fails', () => {
    const secret = authenticator.generateSecret();
    const token = authenticator.generate(secret);
    expect(authenticator.verify({ token, secret })).toBe(true);
    expect(authenticator.verify({ token: '000000', secret })).toBe(false);
  });
});
