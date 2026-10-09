// Every money row is in its country's currency (docs/15 "Currency integrity"). This
// checks a Prisma write before it runs; prisma/currency-guard.sql enforces the same
// rule inside Postgres as the last line of defence.
export const CURRENCY_MODELS = new Set([
  'Application',
  'Device',
  'RepaymentSchedule',
  'Payment',
  'LedgerEntry',
  'Lease',
  'TradeInQuote',
  'ReportRollupFinance',
]);

export interface WriteParams {
  model?: string;
  action: string;
  args?: { data?: unknown; create?: unknown; update?: unknown; where?: unknown };
}

export type TenantCurrencyLookup = (tenantId: string) => Promise<string | null>;
export type RowTenantLookup = (model: string, where: unknown) => Promise<string | null>;

interface Pair {
  tenantId: string | null;
  currency: string;
}

type Row = Record<string, unknown>;

// Prisma accepts `currency: 'GMD'` or `currency: { set: 'GMD' }` on updates.
function currencyIn(data: Row): string | undefined {
  const c = data.currency;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof (c as Row).set === 'string')
    return (c as Row).set as string;
  return undefined;
}

function tenantIn(data: Row | undefined): string | null {
  const t = data?.tenantId;
  return typeof t === 'string' ? t : null;
}

/** Returns a human-readable error when the write mixes currencies, otherwise null. */
export async function findCurrencyMismatch(
  params: WriteParams,
  tenantCurrency: TenantCurrencyLookup,
  rowTenant: RowTenantLookup,
): Promise<string | null> {
  if (!params.model || !CURRENCY_MODELS.has(params.model)) return null;
  const args = params.args ?? {};
  const where = args.where as Row | undefined;
  const pairs: Pair[] = [];
  const add = (data: unknown, fallbackTenant: string | null) => {
    if (!data || typeof data !== 'object') return;
    const currency = currencyIn(data as Row);
    if (currency === undefined) return;
    pairs.push({ tenantId: tenantIn(data as Row) ?? fallbackTenant, currency });
  };

  switch (params.action) {
    case 'create':
      add(args.data, null);
      break;
    case 'createMany':
    case 'createManyAndReturn':
      for (const d of Array.isArray(args.data) ? args.data : [args.data]) add(d, null);
      break;
    case 'upsert': {
      add(args.create, null);
      const data = args.update as Row | undefined;
      if (data && currencyIn(data) !== undefined) {
        add(data, tenantIn(where) ?? (await rowTenant(params.model, where)));
      }
      break;
    }
    case 'update': {
      const data = args.data as Row | undefined;
      if (data && currencyIn(data) !== undefined) {
        add(data, tenantIn(where) ?? (await rowTenant(params.model, where)));
      }
      break;
    }
    case 'updateMany': {
      const data = args.data as Row | undefined;
      if (data && currencyIn(data) !== undefined) {
        if (!tenantIn(data) && !tenantIn(where)) {
          return `${params.model}: changing currency in bulk needs a tenantId filter`;
        }
        add(data, tenantIn(where));
      }
      break;
    }
    default:
      return null;
  }

  for (const p of pairs) {
    // No tenant known (e.g. an update of a row that doesn't exist): Prisma will 404 it.
    if (!p.tenantId) continue;
    const expected = await tenantCurrency(p.tenantId);
    if (expected && p.currency.toUpperCase() !== expected) {
      return `${params.model} amounts in this country must be in ${expected}, not ${p.currency}`;
    }
  }
  return null;
}
