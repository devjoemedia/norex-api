-- Row-Level Security for every tenant-scoped table (docs/01, docs/15).
-- Idempotent. Apply after `prisma db push` and `npm run db:guards`:
--   npm run db:rls
--
-- How the API uses it (src/database/prisma.service.ts): every query runs in a
-- transaction that first sets, transaction-locally,
--   app.tenant_id   : the request's country (tenants.id)
--   app.all_tenants : 'on' for a Super Admin `X-Tenant: all` GET (read only)
--   app.system      : 'on' for trusted cross-country work (catalog clone, scripts)
-- With none of them set, every tenant row is hidden and writes are refused.
--
-- IMPORTANT: Postgres superusers and roles with BYPASSRLS ignore these policies.
-- The API must connect as a normal role (see prisma/roles.sql), or RLS does nothing.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenantId'
      AND tb.table_type = 'BASE TABLE'
      -- Resolving the tenant for a request must work before any tenant is known.
      AND c.table_name NOT IN ('tenant_domains')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_read ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON %I', t);

    -- Reads: own country, the Super Admin all-countries view, or system work.
    EXECUTE format($p$
      CREATE POLICY tenant_read ON %I FOR SELECT USING (
        "tenantId" = current_setting('app.tenant_id', true)
        OR current_setting('app.all_tenants', true) = 'on'
        OR current_setting('app.system', true) = 'on'
      )$p$, t);

    -- Writes: exactly one country (all-countries mode is read only), or system work.
    EXECUTE format($p$
      CREATE POLICY tenant_write ON %I FOR ALL
        USING (
          "tenantId" = current_setting('app.tenant_id', true)
          OR current_setting('app.system', true) = 'on'
        )
        WITH CHECK (
          "tenantId" = current_setting('app.tenant_id', true)
          OR current_setting('app.system', true) = 'on'
        )
    $p$, t);
  END LOOP;
END $$;

-- Tables without "tenantId" (tenants, tenant_domains, catalog_clone_jobs) stay open
-- to the app role: they're read before a tenant is known, or only reachable by
-- Super Admin endpoints.
