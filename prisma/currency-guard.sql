-- Currency integrity inside Postgres (docs/15): a money row's currency must equal
-- its tenant's. The API checks this first (PrismaService currency guard); these
-- triggers catch anything that bypasses it (scripts, raw SQL, nested writes).
-- Idempotent. Apply after `prisma db push`:  npm run db:guards

CREATE OR REPLACE FUNCTION norex_check_currency() RETURNS trigger AS $$
DECLARE
  expected text;
BEGIN
  IF NEW.currency IS NULL THEN
    RETURN NEW; -- applications.currency is optional (set from the plan snapshot)
  END IF;
  SELECT currency INTO expected FROM tenants WHERE id = NEW."tenantId";
  IF expected IS NOT NULL AND upper(NEW.currency) <> expected THEN
    RAISE EXCEPTION 'currency_mismatch: % row in % but tenant currency is %',
      TG_TABLE_NAME, NEW.currency, expected
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'applications', 'devices', 'repayment_schedules', 'payments',
    'ledger_entries', 'leases', 'trade_in_quotes', 'report_rollup_finance'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS norex_currency_guard ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER norex_currency_guard BEFORE INSERT OR UPDATE OF currency, "tenantId" ON %I
         FOR EACH ROW EXECUTE FUNCTION norex_check_currency()', t);
  END LOOP;
END $$;

-- A country's currency can't change once it has money rows (they'd all be wrong).
CREATE OR REPLACE FUNCTION norex_lock_tenant_currency() RETURNS trigger AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency AND (
    EXISTS (SELECT 1 FROM devices WHERE "tenantId" = OLD.id) OR
    EXISTS (SELECT 1 FROM payments WHERE "tenantId" = OLD.id) OR
    EXISTS (SELECT 1 FROM applications WHERE "tenantId" = OLD.id)
  ) THEN
    RAISE EXCEPTION 'currency_locked: tenant % already has priced rows', OLD.subdomain
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS norex_tenant_currency_lock ON tenants;
CREATE TRIGGER norex_tenant_currency_lock BEFORE UPDATE OF currency ON tenants
  FOR EACH ROW EXECUTE FUNCTION norex_lock_tenant_currency();
