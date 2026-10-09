import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { applySchema, createApp, seedTenants, startPostgres } from './e2e-setup';

const GAMBIA = 'gambia.norex.com';
const GHANA = 'ghana.norex.com';

describe('Catalog (integration, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaClient;

  jest.setTimeout(180000);

  async function seedTenantCatalog(tenantId: string, suffix: string, ghanaOnly = false) {
    const brand = await prisma.brand.create({
      data: { tenantId, name: 'Apple', slug: `apple-${suffix}` },
    });
    const category = await prisma.category.create({
      data: { tenantId, name: 'Phones', slug: `phones-${suffix}` },
    });
    const mk = async (
      slug: string,
      o: {
        finance?: boolean;
        lease?: boolean;
        trade?: boolean;
        stock?: number;
        status?: 'published' | 'draft' | 'archived';
      },
    ) => {
      const status = o.status ?? 'published';
      const d = await prisma.device.create({
        data: {
          tenantId,
          brandId: brand.id,
          categoryId: category.id,
          name: slug,
          slug,
          currency: 'GMD',
          cashPriceMinor: 1_000_000,
          status,
          publishedAt: status === 'draft' ? null : new Date(),
          financeEligible: !!o.finance,
          leaseEligible: !!o.lease,
          tradeInEligible: !!o.trade,
        },
      });
      await prisma.deviceVariant.create({
        data: { tenantId, deviceId: d.id, sku: `${slug}-sku`, stockQty: o.stock ?? 5 },
      });
    };

    if (ghanaOnly) {
      await mk('ghana-only', { finance: true });
      return;
    }
    await mk('iphone-16-pro', { finance: true });
    await mk('galaxy-s25', { lease: true });
    await mk('iphone-15', { trade: true });
    await mk('sold-out', { finance: true, stock: 0 });
    await mk('draft-phone', { finance: true, status: 'draft' });
    await mk('old-phone', { finance: true, status: 'archived' });
  }

  beforeAll(async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    applySchema(url);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedTenants(prisma);
    ({ app } = await createApp(url));
    const g = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const h = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'ghana' } });
    await seedTenantCatalog(g.id, 'gm');
    await seedTenantCatalog(h.id, 'gh', true);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  const http = () => request(app.getHttpServer());
  const slugs = (body: { data: { slug: string }[] }) => body.data.map((d) => d.slug).sort();

  it('public list returns only published + in-stock devices, tenant-scoped', async () => {
    const res = await http().get('/api/catalog/devices').set('Host', GAMBIA).expect(200);
    expect(slugs(res.body)).toEqual(['galaxy-s25', 'iphone-15', 'iphone-16-pro']);
    expect(res.body.total).toBe(3);
  });

  it('detail is 200 for published (incl. out-of-stock) and 404 for draft/archived', async () => {
    await http().get('/api/catalog/devices/iphone-16-pro').set('Host', GAMBIA).expect(200);
    await http().get('/api/catalog/devices/sold-out').set('Host', GAMBIA).expect(200);
    await http().get('/api/catalog/devices/draft-phone').set('Host', GAMBIA).expect(404);
    await http().get('/api/catalog/devices/old-phone').set('Host', GAMBIA).expect(404);
  });

  it('trade-lease returns exactly the lease- or trade-eligible published devices', async () => {
    const res = await http().get('/api/catalog/trade-lease').set('Host', GAMBIA).expect(200);
    expect(slugs(res.body)).toEqual(['galaxy-s25', 'iphone-15']); // finance-only iphone-16-pro excluded
  });

  it('is tenant-isolated: the Ghana host sees only the Ghana catalog', async () => {
    const res = await http().get('/api/catalog/devices').set('Host', GHANA).expect(200);
    expect(slugs(res.body)).toEqual(['ghana-only']);
  });

  it('requires no auth for public reads but still needs a tenant host', async () => {
    await http().get('/api/catalog/devices').set('Host', 'nowhere.norex.com').expect(400);
  });
});
