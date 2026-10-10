/**
 * Local-dev only: prints a 12-hour access token for an existing staff user, so the
 * admin portal can use VITE_API_DEV_TOKEN until its login screen exists.
 *
 *   DEV_TOKEN_EMAIL=ops@norex.gm npm run dev:token            # hq super admin
 *   DEV_TOKEN_EMAIL=cm@norex.sl DEV_TOKEN_TENANT=sierra-leone npm run dev:token
 */
import 'dotenv/config';
import { systemPrisma } from '../src/database/system-client';
import { randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';

// RLS is on (prisma/rls.sql): scripts work across every country.
const prisma = systemPrisma();

async function main() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('dev:token is disabled in production.');
  const secret = process.env.JWT_SECRET;
  const email = process.env.DEV_TOKEN_EMAIL;
  const subdomain = process.env.DEV_TOKEN_TENANT ?? 'hq';
  if (!secret || !email) throw new Error('Set JWT_SECRET (in .env) and DEV_TOKEN_EMAIL.');

  const tenant = await prisma.tenant.findUnique({ where: { subdomain } });
  if (!tenant)
    throw new Error(`Tenant "${subdomain}" not found. Run \`npm run prisma:seed\` first.`);
  const user = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email, isStaff: true, status: 'active' },
    include: { roles: true },
  });
  if (!user) throw new Error(`No active staff user ${email} in "${subdomain}".`);

  const token = jwt.sign(
    {
      sub: user.id,
      tenantId: tenant.id,
      roles: user.roles.map((r) => r.role),
      // Delegated admins carry their areas, as a real sign-in does.
      perms: user.roles.some((r) => r.role === 'admin') ? (user.permissions ?? {}) : undefined,
      sid: `dev-${randomUUID()}`,
    },
    secret,
    { expiresIn: '12h' },
  );
  // Token only on stdout so it can be piped into the portal's .env.local.
  console.error(
    `Token for ${email} @ ${subdomain} [${user.roles.map((r) => r.role).join(', ')}], valid 12h:`,
  );
  console.log(token);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
