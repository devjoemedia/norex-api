/**
 * Demo data for the admin portal dashboard (and later pages). Populates a tenant
 * with customers, applications across every status/type, repayment schedules with
 * due/overdue/paid installments, recent successful payments (for the 7-day trend),
 * pending fulfilments (shown as "inspections scheduled"), and audit-log activity.
 *
 *   BOOTSTRAP_ADMIN_TENANT=gambia npm run seed:demo
 *
 * Idempotent-ish: it wipes the tenant's demo transactional tables first, then
 * reseeds. Safe for a local dev database; do NOT run against production.
 */
import { faker } from '@faker-js/faker';
import {
  ApplicationStatus,
  ApplicationType,
  InstallmentStatus,
  KycStatus,
  PaymentChannel,
  PaymentPurpose,
  PaymentStatus,
  Role,
  ScheduleKind,
  UserStatus,
} from '@prisma/client';
import { systemPrisma } from '../src/database/system-client';

// RLS is on (prisma/rls.sql): scripts work across every country.
const prisma = systemPrisma();
const TENANT_SUB = process.env.BOOTSTRAP_ADMIN_TENANT ?? 'gambia';

const APPROVED: Array<ApplicationStatus> = [
  ApplicationStatus.approved,
  ApplicationStatus.active,
  ApplicationStatus.agreement_pending,
];
const PENDING: Array<ApplicationStatus> = [
  ApplicationStatus.submitted,
  ApplicationStatus.under_review,
  ApplicationStatus.info_requested,
];

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// Weighted status distribution → ~150 apps, ~130 approved, ~25 pending.
function makeStatuses(total: number): Array<ApplicationStatus> {
  const out: Array<ApplicationStatus> = []
  for (let i = 0; i < total; i++) {
    const r = Math.random()
    if (r < 0.72) out.push(pick(APPROVED))
    else if (r < 0.89) out.push(pick(PENDING))
    else if (r < 0.97) out.push(pick([ApplicationStatus.declined, ApplicationStatus.withdrawn]))
    else out.push(ApplicationStatus.draft)
  }
  return out
}

function makeType(): ApplicationType {
  const r = Math.random()
  if (r < 0.6) return ApplicationType.financing
  if (r < 0.9) return ApplicationType.lease
  return ApplicationType.trade_in
}

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { subdomain: TENANT_SUB } });
  if (!tenant) throw new Error(`Tenant "${TENANT_SUB}" not found. Run \`npm run prisma:seed\` first.`);
  const tenantId = tenant.id;
  const currency = tenant.currency;

  console.log(`Seeding demo data for tenant ${TENANT_SUB} (${currency})…`);

  // 1. Clean tenant demo data (dev only). Order respects FKs.
  await prisma.payment.deleteMany({ where: { tenantId } });
  await prisma.installment.deleteMany({ where: { tenantId } });
  await prisma.repaymentSchedule.deleteMany({ where: { tenantId } });
  await prisma.fulfilment.deleteMany({ where: { tenantId } });
  await prisma.application.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.kycProfile.deleteMany({ where: { tenantId } });
  await prisma.deviceVariant.deleteMany({ where: { tenantId } });
  await prisma.device.deleteMany({ where: { tenantId } });
  await prisma.branch.deleteMany({ where: { tenantId } });
  // Demo people: all customers + previously-seeded demo staff (roles cascade).
  await prisma.user.deleteMany({ where: { tenantId, isStaff: false } });
  await prisma.user.deleteMany({ where: { tenantId, email: { endsWith: '@demo.norex' } } });

  // 2. Catalog: brands, categories, devices + variants (Product Inventory / POS).
  const categorySpecs = [
    { name: 'Smartphones', slug: 'smartphones' },
    { name: 'Laptops', slug: 'laptops' },
    { name: 'Tablets', slug: 'tablets' },
    { name: 'Accessories', slug: 'accessories' },
  ];
  const categories = [];
  for (const cs of categorySpecs) {
    categories.push(
      await prisma.category.upsert({
        where: { tenantId_slug: { tenantId, slug: cs.slug } },
        update: { name: cs.name },
        create: { tenantId, name: cs.name, slug: cs.slug },
      }),
    );
  }
  const brandSpecs = ['Apple', 'Samsung', 'Tecno', 'Xiaomi', 'HP', 'Dell'];
  const brands = [];
  for (const b of brandSpecs) {
    brands.push(
      await prisma.brand.upsert({
        where: { tenantId_slug: { tenantId, slug: b.toLowerCase() } },
        update: { name: b },
        create: { tenantId, name: b, slug: b.toLowerCase() },
      }),
    );
  }

  const productNames = [
    'iPhone 15 Pro', 'iPhone 14', 'Galaxy S24 Ultra', 'Galaxy A55', 'Tecno Camon 30',
    'Redmi Note 13', 'MacBook Air M3', 'HP Pavilion 15', 'Dell XPS 13', 'iPad Air',
    'Galaxy Tab S9', 'AirPods Pro',
  ];
  const devices = [];
  for (let i = 0; i < productNames.length; i++) {
    const name = productNames[i]!;
    const cat =
      i >= 10 ? categories[3]! : i >= 8 ? categories[2]! : i >= 6 ? categories[1]! : categories[0]!;
    const cashPriceMinor = faker.number.int({ min: 300, max: 4500 }) * 100;
    const device = await prisma.device.create({
      data: {
        tenantId,
        brandId: pick(brands).id,
        categoryId: cat.id,
        name,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`,
        summary: `${name} — available for financing and lease.`,
        cashPriceMinor,
        currency,
        status: Math.random() < 0.85 ? 'published' : 'draft',
        financeEligible: true,
        leaseEligible: Math.random() < 0.6,
        tradeInEligible: Math.random() < 0.4,
        featured: i < 4, // first few are featured
        promoLabel: i % 3 === 0 ? 'Back to School' : null,
        promoPriceMinor: i % 3 === 0 ? Math.round(cashPriceMinor * 0.85) : null,
        publishedAt: new Date(),
        variants: {
          create: Array.from({ length: faker.number.int({ min: 1, max: 3 }) }).map((_, v) => ({
            tenantId,
            sku: `${name.slice(0, 3).toUpperCase()}-${faker.string.alphanumeric(5).toUpperCase()}-${v}`,
            storage: pick(['64GB', '128GB', '256GB', '512GB']),
            color: pick(['Black', 'White', 'Blue', 'Silver', 'Graphite']),
            priceDeltaMinor: v * 15_000,
            stockQty: Math.random() < 0.15 ? 0 : faker.number.int({ min: 1, max: 60 }),
          })),
        },
      },
    });
    devices.push(device);
  }
  const device = devices[0]!;

  // 3. Customers.
  const customerCount = 24;
  const customers = [];
  for (let i = 0; i < customerCount; i++) {
    const c = await prisma.user.create({
      data: {
        tenantId,
        phone: `+220${faker.string.numeric(7)}${i}`,
        fullName: faker.person.fullName(),
        isStaff: false,
        roles: { create: [{ tenantId, role: 'customer' }] },
      },
    });
    customers.push(c);
  }

  // 3b. Staff users with varied roles/status (Users page).
  const staffRoles: Array<Role> = [
    Role.super_admin,
    Role.country_manager,
    Role.approvals_officer,
    Role.product_editor,
    Role.agent,
    Role.approvals_officer,
    Role.agent,
    Role.country_manager,
    Role.product_editor,
    Role.agent,
    Role.approvals_officer,
    Role.agent,
  ];
  let staffCount = 0;
  const branchAdmins: Array<{ id: string; fullName: string | null }> = [];
  for (let i = 0; i < staffRoles.length; i++) {
    const name = faker.person.fullName();
    const staff = await prisma.user.create({
      data: {
        tenantId,
        email: `${faker.internet
          .username({ firstName: name.split(' ')[0] })
          .toLowerCase()}${i}@demo.norex`,
        fullName: name,
        isStaff: true,
        status: Math.random() < 0.85 ? UserStatus.active : UserStatus.suspended,
        roles: { create: [{ tenantId, role: staffRoles[i]! }] },
      },
    });
    if (staffRoles[i] === Role.country_manager) branchAdmins.push(staff);
    staffCount++;
  }

  // 3d. Branches (Branch Management) with some Branch Admins assigned.
  const branchSpecs = [
    { name: 'Norex Banjul Flagship', type: 'store', city: 'Banjul', region: 'Greater Banjul' },
    { name: 'Serrekunda Store', type: 'store', city: 'Serrekunda', region: 'Kanifing' },
    { name: 'Brikama Branch', type: 'store', city: 'Brikama', region: 'West Coast' },
    { name: 'Bakau Pickup Point', type: 'pickup_point', city: 'Bakau', region: 'Kanifing' },
    { name: 'Farafenni Partner', type: 'partner', city: 'Farafenni', region: 'North Bank' },
    { name: 'Basse Partner', type: 'partner', city: 'Basse', region: 'Upper River' },
  ];
  const branches = [];
  for (let i = 0; i < branchSpecs.length; i++) {
    const s = branchSpecs[i]!;
    const manager = i < branchAdmins.length && Math.random() < 0.8 ? branchAdmins[i] : null;
    branches.push(
      await prisma.branch.create({
        data: {
          tenantId,
          name: s.name,
          type: s.type as never,
          city: s.city,
          region: s.region,
          address: faker.location.streetAddress(),
          phone: `+220${faker.string.numeric(7)}`,
          status: Math.random() < 0.9 ? 'active' : 'inactive',
          managerId: manager?.id ?? null,
        },
      }),
    );
  }
  const branchCount = branches.length;

  // 3c. KYC profiles for customers (mixed statuses).
  const kycStatuses = [
    KycStatus.verified,
    KycStatus.verified,
    KycStatus.pending,
    KycStatus.rejected,
  ];
  let kycCount = 0;
  const docKinds = ['id_front', 'id_back', 'selfie', 'proof_of_address'] as const;
  for (const c of customers) {
    const profile = await prisma.kycProfile.create({
      data: {
        tenantId,
        customerId: c.id,
        idTypeCode: tenant.idType,
        idNumberLast4: faker.string.numeric(4),
        status: pick(kycStatuses),
      },
    });
    // A few uploaded documents per profile for the customer detail modal.
    for (const kind of docKinds.slice(0, faker.number.int({ min: 2, max: 4 }))) {
      await prisma.kycDocument.create({
        data: {
          tenantId,
          kycProfileId: profile.id,
          kind,
          storageKey: `kyc/${profile.id}/${kind}.jpg`,
          contentType: 'image/jpeg',
          sizeBytes: faker.number.int({ min: 80_000, max: 900_000 }),
          status: Math.random() < 0.7 ? 'accepted' : 'uploaded',
        },
      });
    }
    kycCount++;
  }

  // 4. Applications.
  const TOTAL = 150;
  const statuses = makeStatuses(TOTAL);
  const applications = [];
  for (let i = 0; i < TOTAL; i++) {
    const status = statuses[i]!;
    const type = makeType();
    const amountMinor = faker.number.int({ min: 800, max: 6000 }) * 100;
    const createdAt = faker.date.recent({ days: 45 });
    const app = await prisma.application.create({
      data: {
        tenantId,
        customerId: pick(customers).id,
        deviceId: pick(devices).id,
        type,
        status,
        amountMinor,
        currency,
        reference: `${type === 'financing' ? 'BNP' : type === 'lease' ? 'LSE' : 'TRD'}-${faker.string.alphanumeric(5).toUpperCase()}`,
        submittedAt: status === ApplicationStatus.draft ? null : createdAt,
        source: Math.random() < 0.25 ? 'admin' : 'self', // some created by admins on behalf
        createdAt,
      },
    });
    applications.push(app);
  }

  // 5. Repayment schedules + installments + payments for approved/active apps.
  const financed = applications.filter((a) => APPROVED.includes(a.status));
  let scheduleCount = 0;
  let paymentCount = 0;
  for (const app of financed) {
    const months = pick([3, 6, 12]);
    const monthly = Math.round((app.amountMinor ?? 0) / months);
    const schedule = await prisma.repaymentSchedule.create({
      data: {
        tenantId,
        applicationId: app.id,
        customerId: app.customerId,
        kind: app.type === ApplicationType.lease ? ScheduleKind.lease : ScheduleKind.financing,
        currency,
        totalAmountMinor: monthly * months,
        status: 'active',
      },
    });
    scheduleCount++;

    for (let seq = 1; seq <= months; seq++) {
      // Spread due dates around now; earlier ones paid, one overdue, rest due.
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (seq - Math.ceil(months / 2)) * 30);
      let status: InstallmentStatus = InstallmentStatus.due;
      let paidAmountMinor = 0;
      let paidAt: Date | null = null;
      if (dueDate < new Date()) {
        // Past due date: mostly paid, some slipped to overdue.
        if (Math.random() < 0.8) {
          status = InstallmentStatus.paid;
          paidAmountMinor = monthly;
          paidAt = new Date(dueDate);
        } else {
          status = InstallmentStatus.overdue;
        }
      }
      const installment = await prisma.installment.create({
        data: {
          tenantId,
          scheduleId: schedule.id,
          seq,
          dueDate,
          amountMinor: monthly,
          paidAmountMinor,
          status,
          paidAt,
        },
      });

      // Successful payments in the last 7 days feed the dashboard trend.
      if (status === InstallmentStatus.paid && Math.random() < 0.5) {
        const when = faker.date.recent({ days: 6 });
        await prisma.payment.create({
          data: {
            tenantId,
            customerId: app.customerId,
            applicationId: app.id,
            scheduleId: schedule.id,
            installmentId: installment.id,
            purpose: PaymentPurpose.installment,
            provider: pick(['visa', 'mastercard', 'mobile_money']),
            channel: PaymentChannel.app,
            amountMinor: monthly,
            currency,
            status: PaymentStatus.succeeded,
            idempotencyKey: faker.string.uuid(),
            createdAt: when,
          },
        });
        paymentCount++;
      }
    }
  }

  // 5b. Failed / reversed payments over the last 7 days → dashboard "overdue" line.
  let failedCount = 0;
  for (let i = 0; i < 45; i++) {
    const app = pick(financed.length ? financed : applications);
    const when = faker.date.recent({ days: 6 });
    await prisma.payment.create({
      data: {
        tenantId,
        customerId: app.customerId,
        applicationId: app.id,
        purpose: PaymentPurpose.installment,
        provider: pick(['visa', 'mastercard', 'mobile_money']),
        channel: PaymentChannel.app,
        amountMinor: faker.number.int({ min: 200, max: 1200 }) * 100,
        currency,
        status: Math.random() < 0.7 ? PaymentStatus.failed : PaymentStatus.reversed,
        failureReason: pick(['insufficient_funds', 'card_declined', 'timeout']),
        idempotencyKey: faker.string.uuid(),
        createdAt: when,
      },
    });
    failedCount++;
  }

  // 6. Pending fulfilments → "inspections scheduled".
  let fulfilmentCount = 0;
  if (branches.length) {
    for (const app of financed.slice(0, 33)) {
      await prisma.fulfilment.create({
        data: {
          tenantId,
          applicationId: app.id,
          branchId: pick(branches).id,
          status: 'pending',
        },
      });
      fulfilmentCount++;
    }
  }

  // 7. Audit log activity (dashboard feed + Activity Log page).
  const actionCatalog = [
    { action: 'application.submitted', entity: 'application', role: 'customer' },
    { action: 'application.approved', entity: 'application', role: 'approvals_officer' },
    { action: 'application.declined', entity: 'application', role: 'approvals_officer' },
    { action: 'fulfilment.report_uploaded', entity: 'fulfilment', role: 'agent' },
    { action: 'fulfilment.officer_assigned', entity: 'fulfilment', role: 'country_manager' },
    { action: 'payment.succeeded', entity: 'payment', role: 'country_manager' },
    { action: 'payment.reversed', entity: 'payment', role: 'country_manager' },
    { action: 'installment.overdue_notice', entity: 'installment', role: 'system' },
    { action: 'user.created', entity: 'user', role: 'super_admin' },
    { action: 'kyc.verified', entity: 'kyc_profile', role: 'approvals_officer' },
    { action: 'kyc.rejected', entity: 'kyc_profile', role: 'approvals_officer' },
    { action: 'device.published', entity: 'device', role: 'product_editor' },
  ];
  let auditCount = 0;
  for (let i = 0; i < 40; i++) {
    const a = pick(actionCatalog);
    await prisma.auditLog.create({
      data: {
        tenantId,
        actorRole: a.role,
        action: a.action,
        entity: a.entity,
        ip: faker.internet.ipv4(),
        createdAt: faker.date.recent({ days: 10 }),
      },
    });
    auditCount++;
  }

  console.log(
    `Done: ${customers.length} customers, ${staffCount} staff, ${kycCount} KYC profiles, ` +
      `${devices.length} products, ${branchCount} branches, ` +
      `${applications.length} applications, ${scheduleCount} schedules, ` +
      `${paymentCount} recent payments, ${failedCount} failed/reversed payments, ` +
      `${fulfilmentCount} pending fulfilments, ${auditCount} audit entries.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
