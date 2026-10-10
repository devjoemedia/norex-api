import { z } from 'zod';

// Single source of truth for environment. The process fails fast at boot if any
// required value is missing or malformed (see docs/00-backend-setup.md).
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),

  // Scaffold uses an HS256 secret for easy local boot; production uses RS256 keys.
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),

  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  THROTTLE_TTL: z.coerce.number().int().positive().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  // At-rest encryption key (>=32 chars). Falls back to JWT_SECRET in the scaffold;
  // production uses a KMS-managed key.
  ENCRYPTION_KEY: z.string().min(32).optional(),

  // Shared secret the website's server sends as X-Web-Key to submit guest
  // applications (docs/16). Unset = the intake endpoint refuses every request.
  WEB_INTAKE_KEY: z.string().min(24).optional(),

  // Where device photos are served (the website, e.g. https://norexgambia.com). The
  // catalog stores website paths like /devices/x.png; the portal needs full URLs.
  DEVICE_IMAGE_BASE_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof schema>;

// Hosting dashboards often keep a variable that's present but blank (e.g. REDIS_URL="").
// Blank means "not set", so optional settings fall back instead of failing as invalid.
export function withoutBlanks(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([, v]) => !(typeof v === 'string' && v.trim() === '')),
  );
}

export function validateEnv(config: Record<string, unknown>): AppConfig {
  const parsed = schema.safeParse(withoutBlanks(config));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
