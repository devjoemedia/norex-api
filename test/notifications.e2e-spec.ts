import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import {
  applySchema,
  createApp,
  seedFinancePlan,
  seedTenants,
  SmsCapture,
  startPostgres,
} from './e2e-setup';

const GAMBIA = 'gambia.norex.com';
const JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

describe('Notifications (integration, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let sms: SmsCapture;
  let prisma: PrismaClient;
  let notifications: NotificationsService;
  let deviceId: string;
  let editor: string;
  let officer: string;

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

  beforeAll(async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    applySchema(url);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedTenants(prisma);
    await seedFinancePlan(prisma);
    ({ app, sms } = await createApp(url));
    notifications = app.get(NotificationsService);
    deviceId = await seedDevice();
    editor = await staffToken('notif-editor@norex.gm', [Role.product_editor]);
    officer = await staffToken('notif-officer@norex.gm', [Role.approvals_officer]);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('manages self preferences: transactional cannot be turned off, marketing can', async () => {
    const customer = await customerToken('+2203300001');
    await http()
      .get('/api/notifications/preferences')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    await http()
      .patch('/api/notifications/preferences')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ channel: 'sms', category: 'transactional', optedIn: false })
      .expect(400);
    await http()
      .patch('/api/notifications/preferences')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ channel: 'sms', category: 'marketing', optedIn: false })
      .expect(200);
  });

  it('registers and revokes a push token', async () => {
    const customer = await customerToken('+2203300002');
    const reg = await http()
      .post('/api/notifications/push-tokens')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ platform: 'fcm', token: 'fcm-device-token-abcdef', deviceId: 'pixel-8' })
      .expect(201);
    await http()
      .delete(`/api/notifications/push-tokens/${reg.body.id}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
  });

  it('gates admin template CRUD by role and validates variables', async () => {
    const customer = await customerToken('+2203300003');
    // customer cannot author templates
    await http()
      .post('/api/admin/notifications/templates')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({
        eventKey: 'application_status',
        channel: 'sms',
        locale: 'en',
        body: 'x {{reference}}',
      })
      .expect(403);

    // an unknown variable is rejected
    await http()
      .post('/api/admin/notifications/templates')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${editor}`)
      .send({ eventKey: 'application_status', channel: 'sms', locale: 'en', body: 'x {{ssn}}' })
      .expect(400);

    const created = await http()
      .post('/api/admin/notifications/templates')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${editor}`)
      .send({
        eventKey: 'application_status',
        channel: 'sms',
        locale: 'en',
        body: 'Norex: {{reference}} is {{status}}.',
      })
      .expect(201);
    expect(created.body.version).toBe(1);

    // editing creates a new active version
    const updated = await http()
      .patch(`/api/admin/notifications/templates/${created.body.id}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${editor}`)
      .send({ body: 'Norex update: {{reference}} -> {{status}}.' })
      .expect(200);
    expect(updated.body.version).toBe(2);
    expect(updated.body.isActive).toBe(true);
  });

  it('sends a transactional message on an application decision, ignoring opt-out', async () => {
    const customer = await customerToken('+2203300010');
    await completeKyc('+2203300010');
    // opt out of everything we can (marketing) — transactional must still send
    await http()
      .patch('/api/notifications/preferences')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ channel: 'sms', category: 'marketing', optedIn: false })
      .expect(200);

    const created = await http()
      .post('/api/applications')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .send({ type: 'financing', deviceId, financeMonths: 6 })
      .expect(201);
    const id = created.body.id;
    await http()
      .post(`/api/applications/${id}/submit`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${customer}`)
      .expect(200);
    await http()
      .post(`/api/applications/${id}/review`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .expect(200);
    const before = sms.messages.length;
    await http()
      .post(`/api/applications/${id}/decision`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${officer}`)
      .send({ decision: 'decline', reason: 'insufficient history' })
      .expect(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const user = await prisma.user.findFirstOrThrow({
      where: { tenantId: tenant.id, phone: '+2203300010' },
    });
    const notes = await prisma.notification.findMany({
      where: { tenantId: tenant.id, userId: user.id, eventKey: 'application_status' },
    });
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.some((n) => n.channel === 'sms' && n.status === 'sent')).toBe(true);
    expect(sms.messages.length).toBeGreaterThan(before); // an SMS actually went out
  });

  it('honours marketing opt-out but still sends to opted-in recipients', async () => {
    // marketing template so opted-in users receive something
    await http()
      .post('/api/admin/notifications/templates')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${editor}`)
      .send({ eventKey: 'marketing', channel: 'sms', locale: 'en', body: '{{title}}: {{message}}' })
      .expect(201);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });

    // opted-out user
    const outPhone = '+2203300020';
    await customerToken(outPhone);
    const outUser = await prisma.user.findFirstOrThrow({
      where: { tenantId: tenant.id, phone: outPhone },
    });
    const outToken = await customerToken(outPhone);
    await http()
      .patch('/api/notifications/preferences')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${outToken}`)
      .send({ channel: 'sms', category: 'marketing', optedIn: false })
      .expect(200);

    // opted-in user (no pref row => default opted-in)
    const inPhone = '+2203300021';
    await customerToken(inPhone);
    const inUser = await prisma.user.findFirstOrThrow({
      where: { tenantId: tenant.id, phone: inPhone },
    });

    const vars = { title: 'Deal', message: 'Save today' };
    await notifications.emit({
      tenantId: tenant.id,
      eventKey: 'marketing',
      userId: outUser.id,
      vars,
    });
    await notifications.emit({
      tenantId: tenant.id,
      eventKey: 'marketing',
      userId: inUser.id,
      vars,
    });

    const outCount = await prisma.notification.count({
      where: { tenantId: tenant.id, userId: outUser.id, eventKey: 'marketing' },
    });
    const inSent = await prisma.notification.count({
      where: { tenantId: tenant.id, userId: inUser.id, eventKey: 'marketing', status: 'sent' },
    });
    expect(outCount).toBe(0); // suppressed before a row is written
    expect(inSent).toBeGreaterThanOrEqual(1);
  });

  it('updates delivery status from a signed provider webhook and rejects unsigned', async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const sent = await prisma.notification.findFirstOrThrow({
      where: { tenantId: tenant.id, status: 'sent', providerMessageId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    const body = JSON.stringify({ providerMessageId: sent.providerMessageId, status: 'delivered' });
    const sig = createHmac('sha256', JWT_SECRET).update(body).digest('hex');

    // unsigned rejected
    await http()
      .post('/api/webhooks/notifications/twilio')
      .set('Host', GAMBIA)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(401);

    await http()
      .post('/api/webhooks/notifications/twilio')
      .set('Host', GAMBIA)
      .set('Content-Type', 'application/json')
      .set('x-signature', sig)
      .send(body)
      .expect(200);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: sent.id } });
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt).toBeTruthy();
  });

  it('isolates templates per tenant', async () => {
    // ghana admin sees none of gambia's templates
    const ghanaTenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'ghana' } });
    const password = 'staff-password-123';
    await prisma.user.create({
      data: {
        tenantId: ghanaTenant.id,
        email: 'gh-manager@norex.gh',
        isStaff: true,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        roles: { create: [{ tenantId: ghanaTenant.id, role: Role.country_manager }] },
      },
    });
    const l = await http()
      .post('/api/auth/staff/login')
      .set('Host', 'ghana.norex.com')
      .send({ email: 'gh-manager@norex.gh', password })
      .expect(200);
    const r = await http()
      .post('/api/auth/staff/2fa')
      .set('Host', 'ghana.norex.com')
      .send({ challengeId: l.body.challengeId, totp: authenticator.generate(l.body.secret) })
      .expect(200);
    const list = await http()
      .get('/api/admin/notifications/templates')
      .set('Host', 'ghana.norex.com')
      .set('Authorization', `Bearer ${r.body.accessToken}`)
      .expect(200);
    expect(list.body).toEqual([]);
  });
});
