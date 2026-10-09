/**
 * Reports money rows whose currency differs from their country's (docs/15). Rows
 * written before the currency guard existed can be wrong; new writes are refused.
 *
 *   npm run check:currency        # exits 1 if any mismatches are found
 */
import { systemPrisma } from '../src/database/system-client';

// RLS is on (prisma/rls.sql): scripts work across every country.
const prisma = systemPrisma();

const TABLES = [
  'applications',
  'devices',
  'repayment_schedules',
  'payments',
  'ledger_entries',
  'leases',
  'trade_in_quotes',
  'report_rollup_finance',
];

async function main() {
  let total = 0;
  for (const table of TABLES) {
    // Table names come from the fixed list above, never from input.
    const rows = await prisma.$queryRawUnsafe<
      Array<{ tenant: string; expected: string; currency: string; n: bigint }>
    >(
      `SELECT t.subdomain AS tenant, t.currency AS expected, r.currency, count(*) AS n
         FROM "${table}" r JOIN tenants t ON t.id = r."tenantId"
        WHERE r.currency IS NOT NULL AND upper(r.currency) <> t.currency
        GROUP BY 1, 2, 3 ORDER BY 1`,
    );
    for (const r of rows) {
      total += Number(r.n);
      console.log(
        `${table}: ${r.n} row(s) in ${r.tenant} are ${r.currency}, expected ${r.expected}`,
      );
    }
  }
  if (total) {
    console.log(`\n${total} mismatched row(s). Fix or delete them before applying db:guards.`);
    process.exitCode = 1;
  } else {
    console.log('✓ Every money row matches its country currency.');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
