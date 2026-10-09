import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  applySchema,
  createApp,
  seedFinancePlan,
  seedTenants,
  SmsCapture,
  startPostgres,
} from './e2e-setup';

const GAMBIA = 'gambia.norex.com';

describe('Applications (integration, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let sms: SmsCapture;
  let prisma: PrismaClient;
  let deviceId: string;

  jest.setTimeout(180000);

  // A published, finance/lease/trade eligible, in-stock device so submit passes the
  // catalog eligibility gate (docs/03).
  async function seedDevice(): Promise<string> {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const brand = await prisma.brand.create({
      data: { tenantId: tenant.id, name: 'Apple', slug: 'apple' },
    });
    const category = await prisma.category.create({
      data: { tenantId: tenant.id, name: 'Phones', slug: 'phones' },
    });
    const device = await prisma.device.create({
      data: {
        tenantId: tenant.id,
        brandId: brand.id,
        categoryId: category.id,
        name: 'iPhone 16 Pro',
        slug: 'iphone-16-pro',
        status: 'published',
        publishedAt: new Date(),
        cashPriceMinor: 120_000_00,
        currency: 'GMD',
        financeEligible: true,
        leaseEligible: true,
        tradeInEligible: true,
      },
    });
    await prisma.deviceVariant.create({
      data: {
        tenantId: tenant.id,
        deviceId: device.id,
        sku: 'IP16P-256-BLK',
        storage: '256GB',
        color: 'Black',
        stockQty: 5,
      },
    });
    return device.id;
  }

  // Complete KYC directly so the customer clears the submit gate (docs/08). Cipher
  // fields only need to be present for the completeness check.
  async function completeKyc(phone: string) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const user = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, phone } });
    await prisma.kycProfile.create({
      data: {
        tenantId: tenant.id,
        customerId: user.id,
        idTypeCode: 'gambia_id',
        idNumberHash: `hash-${user.id}`,
        idNumberLast4: '1234',
        idNumberCipher: 'x',
        addressCipher: 'x',
        employmentCipher: 'x',
        guarantor: {
          create: {
            tenantId: tenant.id,
            fullNameCipher: 'x',
            phoneCipher: 'x',
            relationship: 'sibling',
          },
        },
        documents: {
          create: [
            {
              tenantId: tenant.id,
              kind: 'id_front',
              storageKey: 'k1',
              contentType: 'image/png',
              sizeBytes: 100,
            },
            {
              tenantId: tenant.id,
              kind: 'id_back',
              storageKey: 'k2',
              contentType: 'image/png',
              sizeBytes: 100,
            },
            {
              tenantId: tenant.id,
              kind: 'proof_of_address',
              storageKey: 'k3',
              contentType: 'application/pdf',
              sizeBytes: 100,
            },
          ],
        },
      },
    });
  }

  beforeAll(async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    applySchema(url);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedTenants(prisma);
    await seedFinancePlan(prisma);
    ({ app, sms } = await createApp(url));
    deviceId = await seedDevice();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  const http = () => request(app.getHttpServer());

  async function customerToken(phone: string): Promise<string> {
    await http().post('/api/auth/otp/request').set('Host', GAMBIA).send({ phone }).expect(200);
    const res = await http()
      .post('/api/auth/otp/verify')
      .set('Host', GAMBIA)
      .send({ phone, code: sms.code() })
      .expect(200);
    return res.body.accessToken;
  }

  async function staffToken(email: string, roles: Role[]): Promise<string> {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const password = 'staff-password-123';
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email,
        isStaff: true,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        roles: { create: roles.map((role) => ({ tenantId: tenant.id, role })) },
      },
    });
    const l = await http()
      .post('/api/auth/staff/login')
      .set('Host', GAMBIA)
      .send({ email, password })
      .expect(200);
    const r = await http()
      .post('/api/auth/staff/2fa')
      .set('Host', GAMBIA)
      .send({ challengeId: l.body.challengeId, totp: authenticator.generate(l.body.secret) })
      .expect(200);
    return r.body.accessToken;
  }

  it('runs the full lifecycle: create -> submit -> review -> approve, with an event trail', async () => {
    const customer = await customerToken('+2203100001');
    await completeKyc('+2203100001');
    const officer = await staffToken('officer1@norex.gm', [Role.approvals_officer]);

    // create draft
    const created = await http()
      .post('/api/applications')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ type: 'financing', deviceId, financeMonths: 6 })
      .expect(201);
    const id = created.body.id;
    expect(created.body.status).toBe('draft');

    // submit
    const submitted = await http()
      .post(`/api/applications/${id}/submit`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    expect(submitted.body.status).toBe('submitted');
    expect(submitted.body.reference).toMatch(/^BNP-[A-Z0-9]{6}$/);

    // staff review + approve
    await http()
      .post(`/api/applications/${id}/review`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .expect(200);
    const decided = await http()
      .post(`/api/applications/${id}/decision`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(decided.body.status).toBe('approved');

    // event trail
    const detail = await http()
      .get(`/api/applications/${id}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .expect(200);
    const moves = detail.body.events.map((e: { toStatus: string }) => e.toStatus);
    expect(moves).toEqual(['submitted', 'under_review', 'approved']);

    // deciding again is an illegal transition
    await http()
      .post(`/api/applications/${id}/decision`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .send({ decision: 'decline', reason: 'changed mind' })
      .expect(409);
  });

  it('requires a reason to decline / request info', async () => {
    const customer = await customerToken('+2203100002');
    await completeKyc('+2203100002');
    const officer = await staffToken('officer2@norex.gm', [Role.approvals_officer]);
    const { body: created } = await http()
      .post('/api/applications')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ type: 'financing', deviceId, financeMonths: 6 })
      .expect(201);
    await http()
      .post(`/api/applications/${created.id}/submit`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    await http()
      .post(`/api/applications/${created.id}/review`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .expect(200);
    await http()
      .post(`/api/applications/${created.id}/decision`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .send({ decision: 'decline' })
      .expect(400);
  });

  it('enforces ownership and RBAC', async () => {
    const owner = await customerToken('+2203100003');
    const other = await customerToken('+2203100004');
    const { body: created } = await http()
      .post('/api/applications')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${owner}`)
      .send({ type: 'financing', deviceId, financeMonths: 6 })
      .expect(201);

    // another customer cannot read it
    await http()
      .get(`/api/applications/${created.id}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${other}`)
      .expect(403);
    // a customer cannot decide
    await http()
      .post(`/api/applications/${created.id}/decision`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${owner}`)
      .send({ decision: 'approve' })
      .expect(403);
  });

  it('is idempotent on submit with an Idempotency-Key', async () => {
    const customer = await customerToken('+2203100005');
    await completeKyc('+2203100005');
    const { body: created } = await http()
      .post('/api/applications')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ type: 'financing', deviceId, financeMonths: 6 })
      .expect(201);

    const key = randomUUID();
    const first = await http()
      .post(`/api/applications/${created.id}/submit`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', key)
      .expect(200);
    const second = await http()
      .post(`/api/applications/${created.id}/submit`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', key)
      .expect(200);

    expect(second.body.reference).toBe(first.body.reference);
    const events = await prisma.applicationEvent.count({
      where: { applicationId: created.id, toStatus: 'submitted' },
    });
    expect(events).toBe(1); // submitted exactly once despite the retry
  });
});
