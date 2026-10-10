# Norex API

NestJS + PostgreSQL backend for the Norex platform, scaffolded from
[`docs/00-backend-setup.md`](../docs/00-backend-setup.md). This is the **foundation**
— config, security baseline, tenancy, Prisma, health — ready for the feature
modules described in [`docs/`](../docs) (auth, catalog, applications, payments, …).

## What's included
- **Config** with fail-fast zod validation (`src/config/configuration.ts`).
- **Security baseline** in `main.ts` + `app.module.ts`: helmet, CORS allowlist, global
  `ValidationPipe` (whitelist), `ClassSerializerInterceptor`, uniform exception filter,
  throttling, and the guard chain **JWT → Tenant → Roles**.
- **Multi-tenancy**: host→tenant middleware + `PrismaService.runInTenantContext()` that
  sets the Postgres GUC for **Row-Level Security** (`prisma/rls.sql`).
- **Prisma** schema (`Tenant`, `AuditLog`) + seed (Gambia, Sierra Leone, Guinea, Liberia and the `hq` tenant; the old `ghana` tenant is deactivated).
- **Health**: `GET /api/health/live`, `GET /api/health/ready` (checks the DB).
- **Structured logging** (pino) with PII redaction; Docker + docker-compose.

## Prerequisites
Node 20, Docker.

## Run it
```bash
cp .env.example .env
docker compose up -d          # postgres, redis, minio
npm install
npm run prisma:generate
npm run prisma:migrate        # creates tables (first run: name it "init")
psql "$DATABASE_URL" -f prisma/rls.sql   # enable RLS policies (see docs/01)
npm run prisma:seed           # two demo tenants
npm run start:dev
```
Then: `curl http://localhost:3001/api/health/ready`.

### First super-admin
Staff are created by a super-admin, so bootstrap the first one directly (one-time,
credentials from env, never logged):
```bash
BOOTSTRAP_ADMIN_EMAIL=ops@norex.gm \
BOOTSTRAP_ADMIN_PASSWORD='a-strong-password-min-12' \
BOOTSTRAP_ADMIN_TENANT=gambia \
npm run bootstrap:admin
```
Then sign in at `POST /api/auth/staff/login` to enroll TOTP and receive recovery
codes. Re-run with `BOOTSTRAP_ADMIN_RESET=true` to reset the password + re-enroll TOTP.

## Layout
```
src/
  main.ts app.module.ts
  config/            zod env validation
  common/            guards, decorators, filters, middleware, context, enums
  database/          PrismaService (tenant RLS hook) + module
  health/            liveness / readiness
  modules/           <- feature modules go here (docs 02–13)
prisma/              schema, seed, rls.sql
```

## Tests
```bash
npm test          # unit tests (crypto, TOTP) — no infra needed
npm run test:e2e  # integration tests against a REAL Postgres (needs Docker)
```
The e2e suite (`test/auth.e2e-spec.ts`) starts a throwaway Postgres via
**Testcontainers**, pushes the schema, boots the app, and exercises the full flows
over HTTP: customer OTP → tokens, refresh rotation + reuse detection, logout,
**tenant isolation**, staff password + TOTP enrollment/login, and RBAC on admin
endpoints. Requires a running Docker daemon.

## Conventions (see docs/01)
- Every tenant-scoped table carries `tenant_id` and is protected by RLS.
- Every endpoint declares its role(s) and is tenant-scoped; `@Public()` is explicit.
- Money is integer minor units + ISO currency; times UTC.
- Sensitive changes write an `audit_log` row in the same transaction.
- The scaffold uses an HS256 JWT secret for local boot — **switch to RS256 keys in
  production** (docs/01 & docs/02).

## Next
Generate a feature module: `nest g module modules/auth` (then controller/service),
implementing per the matching doc in [`../docs`](../docs).
