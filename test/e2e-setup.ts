import { execSync } from 'node:child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AppModule } from '../src/app.module';
import { SmsService } from '../src/modules/notifications/sms.service';

// Captures OTP SMS so tests can read the code the API generated.
export class SmsCapture {
  last?: { phone: string; message: string };
  messages: { phone: string; message: string }[] = [];

  async send(phone: string, message: string): Promise<void> {
    this.last = { phone, message };
    this.messages.push({ phone, message });
  }

  code(): string {
    const m = this.last?.message.match(/\b(\d{6})\b/);
    if (!m) throw new Error('No OTP code in the last SMS');
    return m[1];
  }
}

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer('postgres:16-alpine').start();
}

export function applySchema(databaseUrl: string): void {
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
  // Currency triggers (docs/15) so e2e runs against the same guards as production.
  execSync('npx prisma db execute --schema prisma/schema.prisma --file prisma/currency-guard.sql', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

export async function seedTenants(prisma: PrismaClient): Promise<void> {
  const tenants = [
    {
      subdomain: 'gambia',
      name: 'Norex Gambia',
      country: 'GM',
      currency: 'GMD',
      idType: 'Gambia ID',
      code: 'gambia_id',
      regex: '^[0-9]{6,12}$',
    },
    {
      subdomain: 'ghana',
      name: 'Norex Ghana',
      country: 'GH',
      currency: 'GHS',
      idType: 'Ghana Card',
      code: 'ghana_card',
      regex: '^GHA-[0-9]{9}-[0-9]$',
    },
  ];
  for (const t of tenants) {
    const tenant = await prisma.tenant.upsert({
      where: { subdomain: t.subdomain },
      update: {},
      create: {
        subdomain: t.subdomain,
        name: t.name,
        country: t.country,
        currency: t.currency,
        idType: t.idType,
      },
    });
    await prisma.kycIdTypeConfig.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: t.code } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: t.code,
        label: t.idType,
        numberRegex: t.regex,
        requiresSelfie: false,
      },
    });
  }
}

// Seeds an active BNPL plan (3/6/12 months, 20% deposit, 3% monthly markup) with an
// allow-all in-stock rule, so financing quotes and submits resolve.
export async function seedFinancePlan(prisma: PrismaClient, subdomain = 'gambia'): Promise<string> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain } });
  const plan = await prisma.financePlan.create({
    data: {
      tenantId: tenant.id,
      name: 'Standard BNPL',
      isActive: true,
      terms: {
        create: [3, 6, 12].map((months, i) => ({
          tenantId: tenant.id,
          months,
          depositPctBps: 2000,
          monthlyMarkupBps: 300,
          sortOrder: i,
        })),
      },
      rules: { create: [{ tenantId: tenant.id, minPriceMinor: 0, requireInStock: true }] },
    },
  });
  return plan.id;
}

export async function createApp(
  databaseUrl: string,
): Promise<{ app: INestApplication; sms: SmsCapture }> {
  // Env must be set before AppModule compiles (config validation + Prisma).
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
  process.env.JWT_ACCESS_TTL = '900';
  process.env.CORS_ORIGINS = '';

  const sms = new SmsCapture();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SmsService)
    .useValue(sms)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api');
  await app.init();
  return { app, sms };
}
