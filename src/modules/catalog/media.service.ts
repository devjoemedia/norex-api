import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const MAX_BYTES = 8 * 1024 * 1024;

// Media never transits the app: upload via a short-lived signed PUT, delivery via a
// short-lived signed GET. Real S3 signing is wired in docs/00; this seam returns the
// target key + a placeholder URL so the flow is complete end to end.
@Injectable()
export class MediaService {
  constructor(private readonly config: ConfigService) {}

  createUpload(tenantId: string, deviceId: string, contentType: string, bytes: number) {
    const ext = ALLOWED[contentType];
    if (!ext) throw new BadRequestException('Unsupported image type (png, jpeg, webp)');
    if (bytes <= 0 || bytes > MAX_BYTES)
      throw new BadRequestException('Image exceeds the 8MB limit');
    const s3Key = `tenants/${tenantId}/devices/${deviceId}/${randomUUID()}.${ext}`;
    // TODO: real presigned PUT (AWS SDK) — see docs/00.
    return { uploadUrl: `${this.base()}/${s3Key}?stub-signed-put`, s3Key, expiresIn: 300 };
  }

  publicUrl(s3Key: string): string {
    // TODO: short-lived signed GET.
    return `${this.base()}/${s3Key}`;
  }

  private base(): string {
    const endpoint = this.config.get<string>('S3_ENDPOINT') ?? 'https://storage.local';
    const bucket = this.config.get<string>('S3_BUCKET') ?? 'norex';
    return `${endpoint}/${bucket}`;
  }
}
