/**
 * Device unit (IMEI) back-fill + demo seed for the admin portal.
 *
 *   BOOTSTRAP_ADMIN_TENANT=gambia npm run seed:device-units
 *
 * Two parts:
 *  A. Back-fill — for every existing `Fulfilment` that already carries an `imei`,
 *     materialise the persistent `DeviceUnit` (idempotent, keyed on tenantId+imei).
 *     This is the real path; run it once after `prisma db push` adds the tables.
 *  B. Demo top-up — the demo seed creates `pending` fulfilments WITHOUT imeis, so
 *     part A alone yields no units to look at. This generates realistic device units
 *     (active handovers with mixed lock states + lock events, plus in-stock and
 *     dispatched stock) so Device Lock (12), Inventory & Dispatch (08) and the
 *     recovery table (11) are demoable.
 *
 * DEV ONLY: like `seed:demo`, this WIPES the tenant's `device_units` +
 * `device_lock_events` first, then reseeds. Do NOT run against production — a real
 * production back-fill would run part A only, without the wipe. Requires DATABASE_URL
 * in the environment (standalone scripts do not auto-load .env).
 */
import { faker } from '@faker-js/faker';
import {
  ApplicationStatus,
  DeviceEnrollmentStatus,
  DeviceLockAction,
  DeviceLockState,
  DeviceUnitStatus,
  FulfilmentStatus,
  LockActionSource,
  LockProvider,
} from '@prisma/client';
import { systemPrisma } from '../src/database/system-client';

// RLS is on (prisma/rls.sql): scripts work across every country.
const prisma = systemPrisma();
const TENANT_SUB = process.env.BOOTSTRAP_ADMIN_TENANT ?? 'gambia';

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const imei = () => faker.string.numeric(15);
const serial = () => faker.string.alphanumeric(10).toUpperCase();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { subdomain: TENANT_SUB } });
  if (!tenant) throw new Error(`Tenant "${TENANT_SUB}" not found. Run \`npm run prisma:seed\` first.`);
  const tenantId = tenant.id;
  console.log(`Back-filling device units for tenant ${TENANT_SUB}…`);

  // Wipe (dev only). Events first — they FK to units.
  await prisma.deviceLockEvent.deleteMany({ where: { tenantId } });
  await prisma.deviceUnit.deleteMany({ where: { tenantId } });

  // --- Part A: real back-fill from fulfilments that already have an imei ---------
  const withImei = await prisma.fulfilment.findMany({
    where: { tenantId, imei: { not: null } },
  });
  let backfilled = 0;
  for (const f of withImei) {
    const app = f.applicationId
      ? await prisma.application.findFirst({ where: { id: f.applicationId, tenantId } })
      : null;
    await prisma.deviceUnit.upsert({
      where: { tenantId_imei: { tenantId, imei: f.imei! } },
      create: {
        tenantId,
        imei: f.imei!,
        serial: f.serial,
        deviceId: f.deviceId ?? app?.deviceId ?? '',
        customerId: app?.customerId ?? null,
        applicationId: f.applicationId,
        fulfilmentId: f.id,
        branchId: f.branchId,
        status:
          f.status === FulfilmentStatus.fulfilled
            ? DeviceUnitStatus.active
            : DeviceUnitStatus.dispatched,
        activatedAt: f.fulfilledAt,
      },
      update: {
        serial: f.serial ?? undefined,
        deviceId: f.deviceId ?? app?.deviceId ?? undefined,
        customerId: app?.customerId ?? undefined,
        applicationId: f.applicationId,
        fulfilmentId: f.id,
        branchId: f.branchId,
      },
    });
    backfilled++;
  }

  // --- Part B: demo top-up ------------------------------------------------------
  const [devices, branches, activeApps] = await Promise.all([
    prisma.device.findMany({ where: { tenantId }, select: { id: true } }),
    prisma.branch.findMany({ where: { tenantId }, select: { id: true } }),
    prisma.application.findMany({
      where: { tenantId, status: ApplicationStatus.active },
      select: { id: true, customerId: true, deviceId: true },
    }),
  ]);

  let active = 0;
  let soft = 0;
  let hard = 0;
  let events = 0;

  // Active handovers: one unit per active application (cap 80), with a realistic
  // lock-state mix. Locked units get a matching append-only lock event.
  for (const app of activeApps.slice(0, 80)) {
    const provider = pick([LockProvider.knox, LockProvider.android_pay_trigger]);
    const r = Math.random();
    const lockState =
      r < 0.8
        ? DeviceLockState.unlocked
        : r < 0.94
          ? DeviceLockState.soft_locked
          : DeviceLockState.hard_locked;
    const locked = lockState !== DeviceLockState.unlocked;
    const action = locked
      ? lockState === DeviceLockState.soft_locked
        ? DeviceLockAction.soft_lock
        : DeviceLockAction.hard_lock
      : null;
    const lockedAt = locked ? faker.date.recent({ days: 20 }) : null;

    const unit = await prisma.deviceUnit.create({
      data: {
        tenantId,
        imei: imei(),
        serial: serial(),
        deviceId: app.deviceId,
        customerId: app.customerId,
        applicationId: app.id,
        branchId: branches.length ? pick(branches).id : null,
        status: DeviceUnitStatus.active,
        lockState,
        lockProvider: provider,
        enrollment: Math.random() < 0.9 ? DeviceEnrollmentStatus.enrolled : DeviceEnrollmentStatus.failed,
        activatedAt: faker.date.recent({ days: 60 }),
        lastLockAt: lockedAt,
        lastLockAction: action,
      },
    });
    active++;
    if (lockState === DeviceLockState.soft_locked) soft++;
    if (lockState === DeviceLockState.hard_locked) hard++;

    if (locked && action) {
      const automated = Math.random() < 0.5;
      await prisma.deviceLockEvent.create({
        data: {
          tenantId,
          deviceUnitId: unit.id,
          action,
          fromState: DeviceLockState.unlocked,
          toState: lockState,
          source: automated ? LockActionSource.automation : LockActionSource.manual,
          reason: 'Missed payment',
          actorRole: automated ? 'system' : 'approvals_officer',
          provider,
          providerRef: faker.string.uuid(),
          success: true,
          createdAt: lockedAt ?? new Date(),
        },
      });
      events++;
    }
  }

  // Stock: some in-stock (central) + dispatched (to an outlet) units per branch.
  let inStock = 0;
  let dispatched = 0;
  if (devices.length) {
    for (const b of branches) {
      for (let i = 0; i < 4; i++) {
        await prisma.deviceUnit.create({
          data: {
            tenantId,
            imei: imei(),
            serial: serial(),
            deviceId: pick(devices).id,
            status: DeviceUnitStatus.in_stock,
          },
        });
        inStock++;
      }
      for (let i = 0; i < 2; i++) {
        await prisma.deviceUnit.create({
          data: {
            tenantId,
            imei: imei(),
            serial: serial(),
            deviceId: pick(devices).id,
            branchId: b.id,
            status: DeviceUnitStatus.dispatched,
          },
        });
        dispatched++;
      }
    }
  }

  console.log(
    `Done: ${backfilled} back-filled from fulfilments; demo — ${active} active ` +
      `(${soft} soft-locked, ${hard} hard-locked, ${events} lock events), ` +
      `${inStock} in-stock, ${dispatched} dispatched.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
