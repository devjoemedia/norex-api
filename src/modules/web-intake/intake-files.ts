import { BadRequestException } from '@nestjs/common';

export const INTAKE_FILE_KINDS = ['id_front', 'id_back', 'selfie', 'trade_in_photo'] as const;
export type IntakeFileKind = (typeof INTAKE_FILE_KINDS)[number];

// The website shrinks photos to ~1600px JPEG first, so real uploads sit well under this.
export const MAX_INTAKE_FILE_BYTES = 3 * 1024 * 1024;

// The type comes from the bytes themselves, never from what the sender claims.
const SIGNATURES: Array<{ type: string; matches: (b: Buffer) => boolean }> = [
  { type: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    matches: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    matches: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

// Decodes a `data:image/...;base64,` URL into checked image bytes.
export function decodeImageDataUrl(dataUrl: string): { contentType: string; data: Buffer } {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new BadRequestException('Photos must be JPEG, PNG or WebP images');
  const data = Buffer.from(match[1], 'base64');
  if (data.length === 0 || data.length > MAX_INTAKE_FILE_BYTES) {
    throw new BadRequestException('Each photo must be under 3 MB');
  }
  const signature = SIGNATURES.find((s) => s.matches(data));
  if (!signature) throw new BadRequestException('Photos must be JPEG, PNG or WebP images');
  return { contentType: signature.type, data };
}
