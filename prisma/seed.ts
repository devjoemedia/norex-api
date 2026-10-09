import { systemPrisma } from '../src/database/system-client';

// RLS is on (prisma/rls.sql): scripts work across every country.
const prisma = systemPrisma();

import { provisionCountryDefaults } from '../src/modules/countries/country-defaults';

// The four live countries (docs/15). `seedFx` is only used here to pre-fill the FLEX
// minimum fees from Gambia's D2,000 / D3,500; each country edits its own afterwards.
// TODO(countries): confirm the non-Gambia ID labels/regexes and rates before launch.
const COUNTRIES = [
  {
    subdomain: 'gambia',
    name: 'Norex Gambia',
    country: 'GM',
    currency: 'GMD',
    minorUnitDigits: 2,
    dialCode: '+220',
    timezone: 'Africa/Banjul',
    locale: 'en-GM',
    idType: 'Gambia ID',
    idTypeCode: 'gambia_id',
    numberRegex: '^[0-9]{6,12}$',
    city: 'Banjul',
    region: 'Greater Banjul',
    seedFxPpm: 1_000_000,
    roundTo: 1,
    domains: ['norexgambia.com'],
  },
  {
    subdomain: 'sierra-leone',
    name: 'Norex Sierra Leone',
    country: 'SL',
    currency: 'SLE',
    minorUnitDigits: 2,
    dialCode: '+232',
    timezone: 'Africa/Freetown',
    locale: 'en-SL',
    idType: 'National ID (NIN)',
    idTypeCode: 'sl_nin',
    numberRegex: '^[A-Z0-9]{6,20}$',
    city: 'Freetown',
    region: 'Western Area',
    seedFxPpm: 320_000,
    roundTo: 100,
    domains: [],
  },
  {
    subdomain: 'guinea',
    name: 'Norex Guinea',
    country: 'GN',
    currency: 'GNF',
    minorUnitDigits: 0,
    dialCode: '+224',
    timezone: 'Africa/Conakry',
    locale: 'en-GN',
    idType: "Carte d'identité nationale",
    idTypeCode: 'gn_cni',
    numberRegex: '^[A-Z0-9]{6,20}$',
    city: 'Conakry',
    region: 'Conakry',
    seedFxPpm: 122_000_000,
    roundTo: 10_000,
    domains: [],
  },
  {
    subdomain: 'liberia',
    name: 'Norex Liberia',
    country: 'LR',
    currency: 'LRD',
    minorUnitDigits: 2,
    dialCode: '+231',
    timezone: 'Africa/Monrovia',
    locale: 'en-LR',
    idType: 'National ID (NIR)',
    idTypeCode: 'lr_nir',
    numberRegex: '^[A-Z0-9]{6,20}$',
    city: 'Monrovia',
    region: 'Montserrado',
    seedFxPpm: 2_700_000,
    roundTo: 500,
    domains: [],
  },
];

async function main() {
  // hq holds Super Admin accounts only — never business data, never listed as a country.
  await prisma.tenant.upsert({
    where: { subdomain: 'hq' },
    update: { isCountry: false, active: true },
    create: {
      subdomain: 'hq',
      name: 'Norex HQ',
      country: 'XX',
      currency: 'XXX',
      idType: '—',
      isCountry: false,
    },
  });
  console.log('seeded tenant: hq (Super Admin home)');

  // Ghana is no longer a market: keep its rows, but stop resolving it and leave it out
  // of country lists (sign-in, switcher, Countries page).
  await prisma.tenant.updateMany({
    where: { subdomain: 'ghana' },
    data: { active: false, isCountry: false },
  });

  for (const t of COUNTRIES) {
    const profile = {
      name: t.name,
      country: t.country,
      currency: t.currency,
      idType: t.idType,
      minorUnitDigits: t.minorUnitDigits,
      dialCode: t.dialCode,
      timezone: t.timezone,
      locale: t.locale,
      isCountry: true,
    };
    const tenant = await prisma.tenant.upsert({
      where: { subdomain: t.subdomain },
      update: profile,
      create: { subdomain: t.subdomain, ...profile },
    });
    for (const [i, host] of t.domains.entries()) {
      await prisma.tenantDomain.upsert({
        where: { host },
        update: { tenantId: tenant.id },
        create: { tenantId: tenant.id, host, isPrimary: i === 0 },
      });
    }
    const startingFxPpm = t.seedFxPpm;
    const startingRoundStepMinor = t.roundTo * 10 ** t.minorUnitDigits;
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { startingFxPpm, startingRoundStepMinor },
    });
    // Same defaults as "Add country" in the admin portal (country-defaults.ts).
    await provisionCountryDefaults(prisma, {
      tenantId: tenant.id,
      minorUnitDigits: t.minorUnitDigits,
      idType: t.idType,
      idTypeCode: t.idTypeCode,
      idNumberRegex: t.numberRegex,
      startingFxPpm,
      startingRoundStepMinor,
    });

    // A demo branch for the public directory + fulfilment flow (docs/12).
    const existingBranch = await prisma.branch.findFirst({ where: { tenantId: tenant.id } });
    if (!existingBranch) {
      await prisma.branch.create({
        data: {
          tenantId: tenant.id,
          name: `${t.name} Flagship`,
          type: 'store',
          city: t.city,
          region: t.region,
          address: t.subdomain === 'gambia' ? 'Independence Drive' : 'TBC',
          status: 'active',
        },
      });
    }

    console.log(
      `seeded tenant: ${t.subdomain} (${t.currency}) + ID type ${t.idTypeCode} + BNPL/lease/trade-in/branch`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
