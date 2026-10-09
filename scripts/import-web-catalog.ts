/**
 * Copies the website's catalog (norex-web/src/data, incl. the iStore Excel price lock)
 * into one API country so both show the same devices, slugs and storage prices.
 * Reads the website's files only; nothing in norex-web changes.
 *
 *   npm run import:web-catalog                 # dry run: prints what would change
 *   npm run import:web-catalog -- --apply      # writes (default country: gambia)
 *   IMPORT_TENANT=gambia npm run import:web-catalog -- --apply --archive-others
 *
 * Prices are the website's Gambia prices (GMD). Other countries get theirs through
 * the portal's catalog clone, then set their own.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { systemPrisma } from '../src/database/system-client';

const prisma = systemPrisma();
const APPLY = process.argv.includes('--apply');
const ARCHIVE_OTHERS = process.argv.includes('--archive-others');
const TENANT = process.env.IMPORT_TENANT ?? 'gambia';
const WEB = resolve(__dirname, '../../norex-web');

const CATEGORY_NAMES: Record<string, string> = {
  phones: 'Phones',
  tablets: 'Tablets',
  laptops: 'Laptops',
  tvs: 'TVs',
  monitors: 'Monitors',
  accessories: 'Accessories',
};

interface WebProduct {
  slug: string;
  name: string;
  brand: string;
  category: string;
  image: string;
  cutout: string;
  cashPrice: number;
  storage: string;
  color: string;
  featured?: boolean;
  leaseEligible?: boolean;
  tradeInEligible?: boolean;
  specs: unknown;
}
interface WebCatalog {
  getProducts: () => Array<{ slug: string }>;
  getProductBySlug: (slug: string) => WebProduct | undefined;
  computeStorageOptions: (
    p: WebProduct,
  ) => Array<{ storage: string; delta: number; cashPrice: number }>;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Bundle the website's catalog module with its own esbuild, as The Gambia's build.
function loadWebCatalog(): WebCatalog {
  const out = join(mkdtempSync(join(tmpdir(), 'norex-web-catalog-')), 'catalog.cjs');
  execFileSync(
    join(WEB, 'node_modules/.bin/esbuild'),
    [
      join(WEB, 'src/data/products.ts'),
      '--bundle',
      '--format=cjs',
      '--platform=node',
      '--log-level=error',
      `--define:__MARKET__="gm"`,
      `--tsconfig=${join(WEB, 'tsconfig.json')}`,
      `--outfile=${out}`,
    ],
    { cwd: WEB, stdio: 'inherit' },
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(out) as WebCatalog;
}

async function main() {
  const web = loadWebCatalog();
  const tenant = await prisma.tenant.findUnique({ where: { subdomain: TENANT } });
  if (!tenant) throw new Error(`Country "${TENANT}" not found`);
  if (tenant.currency !== 'GMD') {
    throw new Error(
      `The website's prices are GMD; ${TENANT} is ${tenant.currency}. Use the catalog clone.`,
    );
  }
  const toMinor = (gmd: number) => Math.round(gmd * 100);

  const products = web
    .getProducts()
    .map((s) => web.getProductBySlug(s.slug))
    .filter((p): p is WebProduct => !!p);
  const counts = { create: 0, update: 0, same: 0, variants: 0, priceChanges: [] as string[] };

  for (const p of products) {
    const options = web.computeStorageOptions(p);
    const baseMinor = toMinor(options[0]?.cashPrice ?? p.cashPrice);
    const existing = await prisma.device.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug: p.slug } },
      include: { variants: true },
    });
    if (!existing) counts.create++;
    else if (existing.cashPriceMinor !== baseMinor || existing.name !== p.name) {
      counts.update++;
      if (existing.cashPriceMinor !== baseMinor) {
        counts.priceChanges.push(
          `${p.slug}: ${existing.cashPriceMinor / 100} → ${baseMinor / 100}`,
        );
      }
    } else counts.same++;
    counts.variants += Math.max(1, options.length);
    if (!APPLY) continue;

    const brand = await prisma.brand.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: slugify(p.brand) } },
      create: { tenantId: tenant.id, name: p.brand, slug: slugify(p.brand) },
      update: {},
    });
    const category = await prisma.category.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: p.category } },
      create: {
        tenantId: tenant.id,
        name: CATEGORY_NAMES[p.category] ?? p.category,
        slug: p.category,
      },
      update: {},
    });
    const data = {
      name: p.name,
      brandId: brand.id,
      categoryId: category.id,
      cashPriceMinor: baseMinor,
      currency: tenant.currency,
      financeEligible: true,
      leaseEligible: !!p.leaseEligible,
      tradeInEligible: !!p.tradeInEligible,
      featured: !!p.featured,
      // Website photos stay in norex-web for now (docs/15); keep their paths for later.
      specs: { groups: p.specs, webImages: { image: p.image, cutout: p.cutout } } as object,
    };
    const device = await prisma.device.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: p.slug } },
      create: {
        tenantId: tenant.id,
        slug: p.slug,
        ...data,
        status: 'published',
        publishedAt: new Date(),
      },
      update: data,
    });
    const variants = options.length
      ? options.map((o) => ({ storage: o.storage, deltaMinor: toMinor(o.delta) }))
      : [{ storage: null as string | null, deltaMinor: 0 }];
    for (const v of variants) {
      const sku = slugify([p.slug, v.storage].filter(Boolean).join('-'));
      await prisma.deviceVariant.upsert({
        where: { tenantId_sku: { tenantId: tenant.id, sku } },
        // Stock is the country's own business: new variants start at 0, existing keep theirs.
        create: {
          tenantId: tenant.id,
          deviceId: device.id,
          sku,
          storage: v.storage,
          color: p.color,
          priceDeltaMinor: v.deltaMinor,
          stockQty: 0,
        },
        update: { priceDeltaMinor: v.deltaMinor, storage: v.storage, isActive: true },
      });
    }
  }

  const webSlugs = new Set(products.map((p) => p.slug));
  const others = await prisma.device.findMany({
    where: { tenantId: tenant.id, status: { not: 'archived' }, slug: { notIn: [...webSlugs] } },
    select: { slug: true },
  });
  if (APPLY && ARCHIVE_OTHERS && others.length) {
    await prisma.device.updateMany({
      where: { tenantId: tenant.id, slug: { in: others.map((o) => o.slug) } },
      data: { status: 'archived' },
    });
  }

  console.log(
    `${APPLY ? 'Imported' : 'Dry run for'} ${products.length} website devices into ${TENANT}:`,
  );
  console.log(
    `  new: ${counts.create}, updated: ${counts.update}, unchanged: ${counts.same}, variants: ${counts.variants}`,
  );
  if (counts.priceChanges.length)
    console.log(`  price changes:\n    ${counts.priceChanges.join('\n    ')}`);
  console.log(
    `  not on the website: ${others.length}${others.length ? ` (${ARCHIVE_OTHERS && APPLY ? 'archived' : 'left as is; --archive-others to archive'})` : ''}`,
  );
  if (!APPLY) console.log('Nothing written. Re-run with --apply.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
