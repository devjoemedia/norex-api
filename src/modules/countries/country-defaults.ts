import { PrismaClient } from '@prisma/client';
import { convertMinor, minorRatePpm } from './clone.math';

// What every country starts with (docs/15): KYC ID type, the FLEX finance plan, a
// standard lease config + terms, and trade-in condition options. Shared by the seed
// and "Add country", so new countries match the original four. Idempotent.
type Db = Pick<
  PrismaClient,
  | 'kycIdTypeConfig'
  | 'financePlan'
  | 'leaseRateConfig'
  | 'leaseTermsTemplate'
  | 'tradeInConditionOption'
>;

export interface CountryDefaultsInput {
  tenantId: string;
  minorUnitDigits: number;
  idType: string;
  idTypeCode: string;
  idNumberRegex: string;
  /** Target per 1 GMD × 1e6, and the rounding step in the target's minor units. */
  startingFxPpm: number;
  startingRoundStepMinor: number;
}

// Gambia's FLEX (iStore Excel): 20% upfront, fee = max(cash × 7% | 13%, D2,000 | D3,500).
export const FLEX_TERMS = [
  { months: 3, premiumBps: 700, minFeeGmdMinor: 200_000 },
  { months: 6, premiumBps: 1300, minFeeGmdMinor: 350_000 },
];

const GMD_DIGITS = 2;

export async function provisionCountryDefaults(db: Db, c: CountryDefaultsInput): Promise<void> {
  const tenantId = c.tenantId;

  await db.kycIdTypeConfig.upsert({
    where: { tenantId_code: { tenantId, code: c.idTypeCode } },
    update: { label: c.idType, numberRegex: c.idNumberRegex, active: true },
    create: {
      tenantId,
      code: c.idTypeCode,
      label: c.idType,
      numberRegex: c.idNumberRegex,
      requiresSelfie: false,
    },
  });

  // FLEX, with the minimum fees converted from GMD. Older plans are switched off once
  // so quotes match the website.
  if (!(await db.financePlan.findFirst({ where: { tenantId, name: 'FLEX' } }))) {
    const rate = minorRatePpm(c.startingFxPpm, GMD_DIGITS, c.minorUnitDigits);
    await db.financePlan.updateMany({ where: { tenantId }, data: { isActive: false } });
    await db.financePlan.create({
      data: {
        tenantId,
        name: 'FLEX',
        isActive: true,
        terms: {
          create: FLEX_TERMS.map((f, i) => ({
            tenantId,
            months: f.months,
            depositPctBps: 2000,
            monthlyMarkupBps: 0,
            feeMode: 'flat_on_cash' as const,
            premiumBps: f.premiumBps,
            minPremiumMinor: convertMinor(f.minFeeGmdMinor, rate, c.startingRoundStepMinor),
            sortOrder: i,
          })),
        },
        // Customers can finance a device before it's in stock (decision 2026-09-28).
        rules: { create: [{ tenantId, minPriceMinor: 0, requireInStock: false }] },
      },
    });
  }

  // Lease: 9% (6 months) / 6% (12 months) of the cash price per month (docs/05).
  if (!(await db.leaseRateConfig.findFirst({ where: { tenantId } }))) {
    await db.leaseRateConfig.create({
      data: {
        tenantId,
        name: 'Standard Lease',
        isActive: true,
        terms: {
          create: [
            { tenantId, months: 6, monthlyFeeBps: 900, sortOrder: 0 },
            { tenantId, months: 12, monthlyFeeBps: 600, sortOrder: 1 },
          ],
        },
      },
    });
  }

  if (!(await db.leaseTermsTemplate.findFirst({ where: { tenantId } }))) {
    await db.leaseTermsTemplate.create({
      data: {
        tenantId,
        version: 1,
        usageTerms: 'The device is leased for personal use and must be kept in good condition.',
        returnConditions:
          'Return the device by the end date in working condition; damage may incur a fee.',
        noOwnershipNotice:
          'This is a lease. You do not acquire ownership of the device at any point.',
        isActive: true,
      },
    });
  }

  const conditions = [
    { code: 'like_new', label: 'Like new', sortOrder: 0 },
    { code: 'good', label: 'Good', sortOrder: 1 },
    { code: 'fair', label: 'Fair', sortOrder: 2 },
    { code: 'poor', label: 'Poor', sortOrder: 3 },
  ];
  for (const o of conditions) {
    await db.tradeInConditionOption.upsert({
      where: { tenantId_code: { tenantId, code: o.code } },
      update: { label: o.label, sortOrder: o.sortOrder, isActive: true },
      create: { tenantId, code: o.code, label: o.label, sortOrder: o.sortOrder },
    });
  }
}
