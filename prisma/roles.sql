-- The API's database role for RLS (prisma/rls.sql). Run once per database as the
-- owner/superuser, choosing a strong password:
--   psql "$OWNER_DATABASE_URL" -v app_password='…' -f prisma/roles.sql
-- Then point the API's DATABASE_URL at norex_app. Keep the owner URL for
-- `prisma db push`, `npm run db:guards`, `npm run db:rls` and the seed scripts.

SELECT format('CREATE ROLE norex_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'norex_app') \gexec

-- No ALTER ROLE here: CREATE ROLE above already sets NOSUPERUSER NOBYPASSRLS, and on
-- managed Postgres (Neon) the owner isn't a superuser, so ALTER ... SUPERUSER fails.
GRANT USAGE ON SCHEMA public TO norex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO norex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO norex_app;
-- Tables added by later `prisma db push` runs get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO norex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO norex_app;
