import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { applySchema, createApp, seedTenants, startPostgres } from './e2e-setup';

const GAMBIA = 'gambia.norex.com';

describe('Financing / BNPL (integration, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let deviceId: string; // finance-eligible, in stock
  let ineligibleId: string; // not finance-eligible

  jest.setTimeout(180000);

  async function seedDevice(opts: {
    slug: string;
    financeEligible: boolean;
    stockQty: number;
    priceMinor?: number;
  }): Promise<string> {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const brand = await prisma.brand.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: 'apple' } },
      update: {},
      create: { tenantId: tenant.id, name: 'Apple', slug: 'apple' },
    });
    const category = await prisma.category.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: 'phones' } },
      update: {},
      create: { tenantId: tenant.id, name: 'Phones', slug: 'phones' },
    });
    const device = await prisma.device.create({
      data: {
        tenantId: tenant.id,
        brandId: brand.id,
        categoryId: category.id,
        name: `Device ${opts.slug}`,
        slug: opts.slug,
        status: 'published',
        publishedAt: new Date(),
        cashPriceMinor: opts.priceMinor ?? 120_000_00,
        currency: 'GMD',
        financeEligible: opts.financeEligible,
      },
    });
    await prisma.deviceVariant.create({
      data: {
        tenantId: tenant.id,
        deviceId: device.id,
        sku: `${opts.slug}-sku`,
        storage: '256GB',
        color: 'Black',
        stockQty: opts.stockQty,
      },
    });
    return device.id;
  }

  beforeAll(async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    applySchema(url);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedTenants(prisma);
    ({ app } = await createApp(url));
    deviceId = await seedDevice({ slug: 'eligible', financeEligible: true, stockQty: 5 });
    ineligibleId = await seedDevice({ slug: 'cash-only', financeEligible: false, stockQty: 5 });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  const http = () => request(app.getHttpServer());

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

  it('a country_manager creates and activates a plan; a product_editor cannot write', async () => {
    const manager = await staffToken('fin-manager@norex.gm', [Role.country_manager]);
    const editor = await staffToken('fin-editor@norex.gm', [Role.product_editor]);

    // create (20% deposit, 3% monthly markup) across 6 and 12 months
    const created = await http()
      .post('/api/finance/plans')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${manager}`)
      .send({
        name: 'Standard BNPL',
        terms: [
          { months: 6, depositPctBps: 2000, monthlyMarkupBps: 300, sortOrder: 0 },
          { months: 12, depositPctBps: 2000, monthlyMarkupBps: 300, sortOrder: 1 },
        ],
        rules: [{ minPriceMinor: 0, requireInStock: true }],
      })
      .expect(201);
    expect(created.body.terms).toHaveLength(2);

    // editor may read but not create
    await http()
      .get('/api/finance/plans')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${editor}`)
      .expect(200);
    await http()
      .post('/api/finance/plans')
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${editor}`)
      .send({ name: 'x', terms: [{ months: 6, depositPctBps: 0, monthlyMarkupBps: 0 }] })
      .expect(403);

    await http()
      .post(`/api/finance/plans/${created.body.id}/activate`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${manager}`)
      .expect(201);
  });

  it('serves public options and a quote for an eligible in-stock device', async () => {
    const options = await http()
      .get(`/api/finance/plans/${deviceId}/options`)
      .set('Host', GAMBIA)
      .expect(200);
    expect(options.body.currency).toBe('GMD');
    expect(options.body.options.length).toBeGreaterThanOrEqual(2);
    const six = options.body.options.find((o: { months: number }) => o.months === 6);
    expect(six.depositMinor).toBe(120_000_00 * 0.2); // 20% deposit
    // instalments reconstruct the total repayable exactly
    expect(six.monthlyMinor * 5 + six.finalMonthlyMinor).toBe(six.totalRepayableMinor);

    const quote = await http()
      .get('/api/finance/quote')
      .query({ deviceId, months: 6 })
      .set('Host', GAMBIA)
      .expect(200);
    expect(quote.body.months).toBe(6);
    expect(quote.body.planTermId).toBe(six.planTermId);
  });

  it('refuses financing for an ineligible device', async () => {
    const options = await http()
      .get(`/api/finance/plans/${ineligibleId}/options`)
      .set('Host', GAMBIA)
      .expect(200);
    expect(options.body.options).toEqual([]);

    await http()
      .get('/api/finance/quote')
      .query({ deviceId: ineligibleId, months: 6 })
      .set('Host', GAMBIA)
      .expect(400);

    // a term the plan does not offer is rejected
    await http()
      .get('/api/finance/quote')
      .query({ deviceId, months: 9 })
      .set('Host', GAMBIA)
      .expect(400);
  });

  it('records rate history and audit when a term rate changes', async () => {
    const manager = await staffToken('fin-manager2@norex.gm', [Role.country_manager]);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const plan = await prisma.financePlan.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const term = await prisma.financePlanTerm.findFirstOrThrow({
      where: { tenantId: tenant.id, planId: plan.id, months: 6 },
    });

    await http()
      .patch(`/api/finance/plans/${plan.id}/terms/${term.id}`)
      .set('Host', GAMBIA)
      .set('Authorization', `Bearer ${manager}`)
      .send({ monthlyMarkupBps: 350 })
      .expect(200);

    const history = await prisma.financeRateHistory.findMany({ where: { planTermId: term.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      field: 'monthlyMarkupBps',
      oldValue: '300',
      newValue: '350',
    });

    const audit = await prisma.auditLog.count({
      where: { tenantId: tenant.id, action: 'finance.term.updated' },
    });
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('isolates plans per tenant (ghana has none of gambia’s plans)', async () => {
    const options = await http()
      .get(`/api/finance/plans/${deviceId}/options`)
      .set('Host', 'ghana.norex.com')
      .expect(200);
    // the gambia device id is invisible under the ghana tenant
    expect(options.body.options).toEqual([]);
  });
});
