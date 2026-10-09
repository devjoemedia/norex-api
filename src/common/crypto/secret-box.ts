import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// App-level envelope encryption for at-rest secrets (e.g. TOTP secrets). Scaffold
// derives a 256-bit key from the configured secret; production uses a KMS-managed
// data key (docs/01-security-and-multitenancy.md). Format: iv.tag.ciphertext (base64).
function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join('.');
}

export function decryptSecret(payload: string, secret: string): string {
  const [ivB, tagB, dataB] = payload.split('.');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
