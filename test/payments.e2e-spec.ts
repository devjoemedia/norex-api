import { createHmac, randomUUID } from 'node:crypto';
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
const SECRET = 'whsec_sandbox_test_secret_0123456789';

describe('Payments & repayments (integration, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let sms: SmsCapture;
  let prisma: PrismaClient;
  let deviceId: string;
  let officer: string;
  let manager: string;
  let customer: string;
  let scheduleId: string;
  let installmentIds: string[]; // by seq

  jest.setTimeout(240000);

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
      },
    });
    await prisma.deviceVariant.create({
      data: {
        tenantId: tenant.id,
        deviceId: device.id,
        sku: 'IP16P',
        storage: '256GB',
        color: 'Black',
        stockQty: 5,
      },
    });
    return device.id;
  }

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

  // POSTs a signed provider webhook with an exact raw body so the signature matches.
  function webhook(body: Record<string, unknown>, opts: { signature?: string } = {}) {
    const raw = JSON.stringify(body);
    const sig = opts.signature ?? createHmac('sha256', SECRET).update(raw).digest('hex');
    return http()
      .post('/api/webhooks/payments/sandbox')
      .set('Host', GAMBIA)
      .set('Content-Type', 'application/json')
      .set('x-signature', sig)
      .send(raw);
  }

  async function pay(token: string, installmentId: string, amountMinor: number) {
    const init = await http()
      .post('/api/payments/initiate')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        purpose: 'installment',
        installmentId,
        amountMinor,
        provider: 'sandbox',
        channel: 'app',
      })
      .expect(201);
    return init.body as { id: string; providerRef: string; amountMinor: number };
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

    officer = await staffToken('pay-officer@norex.gm', [Role.approvals_officer]);
    manager = await staffToken('pay-manager@norex.gm', [Role.country_manager]);

    // enable the sandbox provider for this tenant
    await http()
      .post('/api/admin/payments/providers')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${manager}`)
      .send({ provider: 'sandbox', webhookSecret: SECRET })
      .expect(201);

    // drive one application to active: submit -> approve -> agreement -> deposit -> activate
    customer = await customerToken('+2203200001');
    await completeKyc('+2203200001');
    const created = await http()
      .post('/api/applications')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ type: 'financing', deviceId, financeMonths: 6 })
      .expect(201);
    const appId = created.body.id;
    await http()
      .post(`/api/applications/${appId}/submit`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    await http()
      .post(`/api/applications/${appId}/review`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .expect(200);
    await http()
      .post(`/api/applications/${appId}/decision`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .send({ decision: 'approve' })
      .expect(200);
    await http()
      .post(`/api/applications/${appId}/agreement`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);

    const detail = await http()
      .get(`/api/applications/${appId}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    const depositMinor = detail.body.planSnapshot.depositMinor as number;
    expect(depositMinor).toBe(120_000_00 * 0.2);

    const dep = await http()
      .post('/api/payments/initiate')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        purpose: 'deposit',
        applicationId: appId,
        amountMinor: depositMinor,
        provider: 'sandbox',
        channel: 'app',
      })
      .expect(201);
    await webhook({
      eventId: randomUUID(),
      providerRef: dep.body.providerRef,
      status: 'succeeded',
      amountMinor: depositMinor,
      currency: 'GMD',
    }).expect(200);

    const activated = await http()
      .post(`/api/applications/${appId}/activate`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .expect(200);
    scheduleId = activated.body.id;

    const sched = await http()
      .get(`/api/schedules/${scheduleId}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    installmentIds = sched.body.installments
      .sort((a: { seq: number }, b: { seq: number }) => a.seq - b.seq)
      .map((i: { id: string }) => i.id);
    // seq 0 deposit is paid; monthly instalments seq 1..6 are due
    expect(sched.body.installments.find((i: { seq: number }) => i.seq === 0).status).toBe('paid');
    expect(sched.body.installments).toHaveLength(7);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('confirms an installment on a signed webhook: ledger balances + receipt issued', async () => {
    const inst = await prisma.installment.findUniqueOrThrow({ where: { id: installmentIds[1] } });
    const p = await pay(customer, inst.id, inst.amountMinor);
    await webhook({
      eventId: randomUUID(),
      providerRef: p.providerRef,
      status: 'succeeded',
      amountMinor: inst.amountMinor,
      currency: 'GMD',
    }).expect(200);

    const paid = await prisma.installment.findUniqueOrThrow({ where: { id: inst.id } });
    expect(paid.status).toBe('paid');
    expect(paid.paidAmountMinor).toBe(inst.amountMinor);

    // double-entry balanced for this payment
    const entries = await prisma.ledgerEntry.findMany({ where: { paymentId: p.id } });
    const debit = entries
      .filter((e) => e.direction === 'debit')
      .reduce((s, e) => s + e.amountMinor, 0);
    const credit = entries
      .filter((e) => e.direction === 'credit')
      .reduce((s, e) => s + e.amountMinor, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(inst.amountMinor);

    const receipt = await http()
      .get(`/api/payments/${p.id}/receipt`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    expect(receipt.body.number).toMatch(/^RCP-\d{6}$/);
  });

  it('posts exactly once under a re-delivered (duplicate) webhook', async () => {
    const inst = await prisma.installment.findUniqueOrThrow({ where: { id: installmentIds[2] } });
    const p = await pay(customer, inst.id, inst.amountMinor);
    const eventId = randomUUID();
    const body = {
      eventId,
      providerRef: p.providerRef,
      status: 'succeeded',
      amountMinor: inst.amountMinor,
      currency: 'GMD',
    };

    const first = await webhook(body).expect(200);
    const second = await webhook(body).expect(200);
    expect(first.body.status).toBe('succeeded');
    expect(second.body.status).toBe('duplicate');

    const entries = await prisma.ledgerEntry.count({ where: { paymentId: p.id } });
    expect(entries).toBe(2); // one debit + one credit, not doubled
  });

  it('rejects an unsigned/forged webhook and applies nothing', async () => {
    const inst = await prisma.installment.findUniqueOrThrow({ where: { id: installmentIds[3] } });
    const p = await pay(customer, inst.id, inst.amountMinor);
    await webhook(
      {
        eventId: randomUUID(),
        providerRef: p.providerRef,
        status: 'succeeded',
        amountMinor: inst.amountMinor,
        currency: 'GMD',
      },
      { signature: 'deadbeef' },
    ).expect(401);

    const still = await prisma.installment.findUniqueOrThrow({ where: { id: inst.id } });
    expect(still.status).toBe('due');
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(payment.status).toBe('pending');
  });

  it('quarantines an amount mismatch instead of applying it', async () => {
    const inst = await prisma.installment.findUniqueOrThrow({ where: { id: installmentIds[4] } });
    const p = await pay(customer, inst.id, inst.amountMinor);
    const res = await webhook({
      eventId: randomUUID(),
      providerRef: p.providerRef,
      status: 'succeeded',
      amountMinor: inst.amountMinor - 1, // tampered
      currency: 'GMD',
    }).expect(200);
    expect(res.body.status).toBe('amount_mismatch');

    const still = await prisma.installment.findUniqueOrThrow({ where: { id: inst.id } });
    expect(still.status).toBe('due');
    const entries = await prisma.ledgerEntry.count({ where: { paymentId: p.id } });
    expect(entries).toBe(0);
  });

  it('refunds via compensating entries, never mutating the ledger', async () => {
    const inst = await prisma.installment.findUniqueOrThrow({ where: { id: installmentIds[5] } });
    const p = await pay(customer, inst.id, inst.amountMinor);
    await webhook({
      eventId: randomUUID(),
      providerRef: p.providerRef,
      status: 'succeeded',
      amountMinor: inst.amountMinor,
      currency: 'GMD',
    }).expect(200);

    const refund = await http()
      .post(`/api/admin/payments/${p.id}/refund`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${manager}`)
      .send({ amountMinor: inst.amountMinor, reason: 'customer changed mind' })
      .expect(201);
    expect(refund.body.status).toBe('reversed');

    const entries = await prisma.ledgerEntry.findMany({
      where: { paymentId: p.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries).toHaveLength(4); // original 2 + compensating 2
    const net = entries.reduce(
      (s, e) => s + (e.direction === 'debit' ? e.amountMinor : -e.amountMinor),
      0,
    );
    expect(net).toBe(0); // fully reversed

    const back = await prisma.installment.findUniqueOrThrow({ where: { id: inst.id } });
    expect(back.status).toBe('due');
    expect(back.paidAmountMinor).toBe(0);
  });

  it('enforces ownership on schedules and payments', async () => {
    const other = await customerToken('+2203200099');
    await http()
      .get(`/api/schedules/${scheduleId}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${other}`)
      .expect(403);
    // staff may read across the tenant
    await http()
      .get(`/api/schedules/${scheduleId}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .expect(200);
  });

  it('reports reconciliation numbers to a country manager', async () => {
    const recon = await http()
      .get('/api/admin/reconciliation')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${manager}`)
      .expect(200);
    expect(typeof recon.body.ledgerCashMinor).toBe('number');
    expect(typeof recon.body.diffMinor).toBe('number');
  });
});
