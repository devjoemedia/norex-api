import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

// Shared object-storage seam. Bytes never transit the app: uploads go through a
// short-lived signed PUT and delivery through a short-lived signed GET. Real S3
// signing is wired in docs/00; this returns the target key + a placeholder URL so
// every feature flow (lease returns, trade-in photos, CMS media, report exports)
// is complete end to end. Mirrors catalog's MediaService, generalized by prefix.
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface SignedUpload {
  uploadUrl: string;
  key: string;
  expiresIn: number;
}

@Injectable()
export class StorageService {
  constructor(private readonly config: ConfigService) {}

  // Signed PUT for an image (returns the tenant-prefixed key to persist).
  createImageUpload(
    tenantId: string,
    prefix: string,
    contentType: string,
    bytes: number,
  ): SignedUpload {
    const ext = IMAGE_TYPES[contentType];
    if (!ext) throw new BadRequestException('Unsupported image type (png, jpeg, webp)');
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES)
      throw new BadRequestException('Image exceeds the 8MB limit');
    const key = `tenants/${tenantId}/${prefix}/${randomUUID()}.${ext}`;
    return { uploadUrl: `${this.base()}/${key}?stub-signed-put`, key, expiresIn: 300 };
  }

  // Signed PUT for an arbitrary generated artefact (e.g. an export file).
  createObjectKey(tenantId: string, prefix: string, ext: string): string {
    return `tenants/${tenantId}/${prefix}/${randomUUID()}.${ext}`;
  }

  // Short-lived signed GET. TODO: real presigned URL (AWS SDK) — see docs/00.
  signedGet(key: string, expiresIn = 300): string {
    return `${this.base()}/${key}?stub-signed-get&ttl=${expiresIn}`;
  }

  private base(): string {
    const endpoint = this.config.get<string>('S3_ENDPOINT') ?? 'https://storage.local';
    const bucket = this.config.get<string>('S3_BUCKET') ?? 'norex';
    return `${endpoint}/${bucket}`;
  }
}
