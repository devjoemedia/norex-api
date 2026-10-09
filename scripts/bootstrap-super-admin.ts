/**
 * One-time bootstrap of the first super-admin (the account that creates all other
 * staff). Reads credentials from env — never from CLI args (which are visible in
 * the process list) and never logged. Idempotent: safe to re-run.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=ops@norex.gm \
 *   BOOTSTRAP_ADMIN_PASSWORD='a-strong-password' \
 *   BOOTSTRAP_ADMIN_TENANT=hq \
 *   npm run bootstrap:admin
 *
 * The created account still enrolls TOTP on first login (POST /api/auth/staff/login).
 */
import { Role } from '@prisma/client';
import { systemPrisma } from '../src/database/system-client';
import * as argon2 from 'argon2';

// RLS is on (prisma/rls.sql): scripts work across every country.
const prisma = systemPrisma();

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const subdomain = process.env.BOOTSTRAP_ADMIN_TENANT ?? 'hq';
  const reset = process.env.BOOTSTRAP_ADMIN_RESET === 'true';

  if (!email || !password) {
    throw new Error(
      'Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (optionally BOOTSTRAP_ADMIN_TENANT).',
    );
  }
  if (password.length < 12) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const tenant = await prisma.tenant.findUnique({ where: { subdomain } });
  if (!tenant) {
    throw new Error(`Tenant "${subdomain}" not found. Run \`npm run prisma:seed\` first.`);
  }

  const existing = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email },
    include: { roles: true },
  });

  if (existing) {
    if (!existing.roles.some((r) => r.role === Role.super_admin)) {
      await prisma.userRole.create({
        data: { userId: existing.id, tenantId: tenant.id, role: Role.super_admin },
      });
    }
    if (reset) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
          status: 'active',
          totpSecret: null,
          totpEnabledAt: null, // re-enroll TOTP on next login
        },
      });
    }
    console.log(
      `Super-admin already exists: ${email} @ ${subdomain}${reset ? ' — password reset, TOTP re-enrollment required' : ''}. Role ensured.`,
    );
    return;
  }

  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email,
      fullName: 'Platform Super Admin',
      isStaff: true,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      roles: { create: { tenantId: tenant.id, role: Role.super_admin } },
    },
  });

  console.log(`Created super-admin ${email} @ ${subdomain} (user ${user.id}).`);
  console.log(
    'Next: POST /api/auth/staff/login with this email + password to enroll TOTP and receive recovery codes.',
  );
}

main()
  .catch((e) => {
    console.error('Bootstrap failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
