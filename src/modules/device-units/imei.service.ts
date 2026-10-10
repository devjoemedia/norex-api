import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { keyedHash } from '../../common/crypto/hash.util';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';
import { isValidImei, normalizeImei } from './imei.util';

export interface SealedImei {
  imeiCipher: string;
  imeiHash: string;
  imeiLast4: string;
}

export interface ImeiSecrets {
  jwtSecret: string;
  encryptionKey?: string;
}

// Shared with scripts (demo seed) so every writer seals IMEIs the same way.
export function imeiHashOf(tenantId: string, imei: string, secrets: ImeiSecrets): string {
  return keyedHash(`${secrets.jwtSecret}:imei:${tenantId}`, normalizeImei(imei));
}

export function sealImei(tenantId: string, imei: string, secrets: ImeiSecrets): SealedImei {
  const clean = normalizeImei(imei);
  return {
    imeiCipher: encryptSecret(clean, secrets.encryptionKey ?? secrets.jwtSecret),
    imeiHash: imeiHashOf(tenantId, clean, secrets),
    imeiLast4: clean.slice(-4),
  };
}

// The only place a raw IMEI is handled (docs/18). Stored as an AES-256-GCM cipher
// (staff reveal), a per-country keyed HMAC (exact lookup + uniqueness) and last 4.
@Injectable()
export class ImeiService {
  constructor(private readonly config: ConfigService) {}

  private secrets(): ImeiSecrets {
    return {
      jwtSecret: this.config.get<string>('JWT_SECRET')!,
      encryptionKey: this.config.get<string>('ENCRYPTION_KEY'),
    };
  }

  // Throws a customer-safe message for anything that isn't a real IMEI.
  validate(raw: string): string {
    const imei = normalizeImei(raw ?? '');
    if (!isValidImei(imei)) {
      throw new BadRequestException(
        'Enter a valid 15-digit IMEI (dial *#06# on the phone or check the box)',
      );
    }
    return imei;
  }

  hash(tenantId: string, raw: string): string {
    return imeiHashOf(tenantId, raw, this.secrets());
  }

  seal(tenantId: string, raw: string): SealedImei {
    return sealImei(tenantId, this.validate(raw), this.secrets());
  }

  reveal(cipher: string): string {
    const { encryptionKey, jwtSecret } = this.secrets();
    return decryptSecret(cipher, encryptionKey ?? jwtSecret);
  }
}
