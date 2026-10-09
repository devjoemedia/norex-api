import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Keyed hash for tokens/OTP codes (not passwords — staff passwords use Argon2id
// in the staff-login slice). The key is the app secret; values are peppered.
export function keyedHash(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function randomTokenHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

// Constant-time compare of two hex strings.
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Constant-time compare of two secrets of any length (hashing evens the lengths).
export function safeEqualText(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Cryptographically-random numeric OTP of the given length.
export function numericOtp(length = 6): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, '0');
}
