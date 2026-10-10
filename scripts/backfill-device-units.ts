/**
 * Demo device units (IMEI) for the admin portal.
 *
 *   BOOTSTRAP_ADMIN_TENANT=gambia npm run seed:device-units
 *
 * Generates realistic units: active handovers with mixed lock states + lock events,
 * plus in-stock and dispatched stock, so Devices, Device Lock and the recovery table
 * are demoable. IMEIs are valid (Luhn) and sealed exactly like the API seals them
 * (encrypted + keyed hash, docs/18), so it needs JWT_SECRET (and ENCRYPTION_KEY if
 * the API uses one) plus DATABASE_URL in the environment.
 *
 * DEV ONLY: like `seed:demo`, this WIPES the tenant's `device_units` +
 * `device_lock_events` first. Real units come from stock intake and hand-overs.
 */
import { faker } from '@faker-js/faker';
import {
  ApplicationStatus,
  DeviceEnrollmentStatus,
  DeviceLockAction,
  DeviceLockState,
  DeviceUnitStatus,
  LockActionSource,
  LockProvider,
} from '@prisma/client';
import { systemPrisma } from '../src/database/system-client';
import { sealImei } from '../src/modules/device-units/imei.service';

// RLS is on (prisma/rls.sql): scripts work across every country.
const prisma = systemPrisma();
const TENANT_SUB = process.env.BOOTSTRAP_ADMIN_TENANT ?? 'gambia';

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const SECRETS = {
  jwtSecret: process.env.JWT_SECRET ?? '',
  encryptionKey: process.env.ENCRYPTION_KEY,
};

// A random IMEI with a correct Luhn check digit.
function randomImei(): string {
  const body = faker.string.numeric(14);
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}
const serial = () => faker.string.alphanumeric(10).toUpperCase();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { subdomain: TENANT_SUB } });
  if (!tenant)
    throw new Error(`Tenant "${TENANT_SUB}" not found. Run \`npm run prisma:seed\` first.`);
  if (!SECRETS.jwtSecret) throw new Error('Set JWT_SECRET (same value as the API) to seal IMEIs.');
  const tenantId = tenant.id;
  const imei = () => sealImei(tenantId, randomImei(), SECRETS);
  console.log(`Back-filling device units for tenant ${TENANT_SUB}…`);

  // Wipe (dev only). Events first — they FK to units.
  await prisma.deviceLockEvent.deleteMany({ where: { tenantId } });
  await prisma.deviceUnit.deleteMany({ where: { tenantId } });

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
        ...imei(),
        serial: serial(),
        deviceId: app.deviceId,
        customerId: app.customerId,
        applicationId: app.id,
        branchId: branches.length ? pick(branches).id : null,
        status: DeviceUnitStatus.active,
        lockState,
        lockProvider: provider,
        enrollment:
          Math.random() < 0.9 ? DeviceEnrollmentStatus.enrolled : DeviceEnrollmentStatus.failed,
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
            ...imei(),
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
            ...imei(),
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
    `Done: ${active} active ` +
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
