import { findCurrencyMismatch } from './currency-guard';

const currencies: Record<string, string> = { gm: 'GMD', gn: 'GNF' };
const tenantCurrency = async (id: string) => currencies[id] ?? null;
const rowTenant = async () => 'gn';

const check = (model: string, action: string, args: object) =>
  findCurrencyMismatch({ model, action, args }, tenantCurrency, rowTenant);

describe('currency guard', () => {
  it('passes a create in the country currency', async () => {
    expect(
      await check('Payment', 'create', { data: { tenantId: 'gm', currency: 'GMD' } }),
    ).toBeNull();
  });

  it('refuses a create in another currency', async () => {
    expect(await check('Payment', 'create', { data: { tenantId: 'gn', currency: 'GMD' } })).toMatch(
      /must be in GNF/,
    );
  });

  it('checks every row of a createMany', async () => {
    const data = [
      { tenantId: 'gm', currency: 'GMD' },
      { tenantId: 'gm', currency: 'LRD' },
    ];
    expect(await check('LedgerEntry', 'createMany', { data })).toMatch(/must be in GMD/);
  });

  it('looks up the row tenant for an update by id', async () => {
    expect(
      await check('Device', 'update', { where: { id: 'x' }, data: { currency: 'GMD' } }),
    ).toMatch(/must be in GNF/);
    expect(
      await check('Device', 'update', { where: { id: 'x' }, data: { currency: { set: 'GNF' } } }),
    ).toBeNull();
  });

  it('ignores updates that do not touch currency, and other models', async () => {
    expect(await check('Device', 'update', { where: { id: 'x' }, data: { name: 'y' } })).toBeNull();
    expect(await check('User', 'create', { data: { tenantId: 'gm', currency: 'LRD' } })).toBeNull();
  });

  it('checks both branches of an upsert', async () => {
    expect(
      await check('ReportRollupFinance', 'upsert', {
        where: { tenantId_day_currency: { tenantId: 'gm' } },
        create: { tenantId: 'gm', currency: 'GNF' },
        update: {},
      }),
    ).toMatch(/must be in GMD/);
  });

  it('refuses a bulk currency change without a tenant filter', async () => {
    expect(await check('Payment', 'updateMany', { where: {}, data: { currency: 'GMD' } })).toMatch(
      /needs a tenantId filter/,
    );
  });
});
