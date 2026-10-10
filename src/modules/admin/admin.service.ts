import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StaffInviteService } from '../auth/staff-invite.service';
import { currencyOf } from '../../common/tenancy/currency';
import { assertCanGrant, canGrant } from '../../common/tenancy/staff-roles';
import {
  Application,
  ApplicationStatus,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { getContext } from '../../common/context/request-context';
import { maskImei } from '../device-units/imei.util';
import { KycService } from '../kyc/kyc.service';
import { ConfigService } from '@nestjs/config';
import { deviceImageUrl } from '../../common/catalog/device-image';
import { summariseOrigins } from './channel-analytics';
import { AdminPermissions, normalizePermissions } from '../../common/auth/admin-permissions';

// Read models for the admin portal's list pages. Tenant-scoped, plain Prisma
// reads shaped for the tables (rows + stat cards). Mirrors DashboardService.
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly kycProfiles: KycService,
    private readonly config: ConfigService,
    private readonly invites: StaffInviteService,
  ) {}

  private imageUrl(specs: unknown): string | null {
    return deviceImageUrl(specs, this.config.get<string>('DEVICE_IMAGE_BASE_URL'));
  }

  private async tenant(tenantId: string) {
    return this.prisma.tenant.findUnique({ where: { id: tenantId } });
  }

  // --- Applications -------------------------------------------------------
  async applications(tenantId: string) {
    const tenant = await this.tenant(tenantId);
    const currency = currencyOf(tenant);

    const [rowsRaw, byStatus, byType, orders] = await Promise.all([
      this.prisma.application.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.application.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.application.groupBy({
        by: ['type'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.order.count({ where: { tenantId } }),
    ]);
    const ofType = (t: string) => byType.find((r) => r.type === t)?._count._all ?? 0;

    const { userNames, deviceNames, deviceImages } = await this.resolveNames(
      rowsRaw.map((r) => r.customerId),
      rowsRaw.map((r) => r.deviceId),
    );

    const count = (s: Array<ApplicationStatus>) =>
      byStatus.filter((r) => s.includes(r.status)).reduce((n, r) => n + r._count._all, 0);

    return {
      stats: {
        total: byStatus.reduce((n, r) => n + r._count._all, 0),
        approved: count([
          ApplicationStatus.approved,
          ApplicationStatus.active,
          ApplicationStatus.agreement_pending,
        ]),
        pending: count([
          ApplicationStatus.submitted,
          ApplicationStatus.under_review,
          ApplicationStatus.info_requested,
        ]),
        rejected: count([ApplicationStatus.declined, ApplicationStatus.withdrawn]),
      },
      // Website request categories for the portal tabs (cash orders live in their own table).
      categories: {
        financing: ofType('financing'),
        lease: ofType('lease'),
        trade_in: ofType('trade_in'),
        orders,
      },
      currency,
      rows: rowsRaw.map((r) => ({
        id: r.id,
        reference: r.reference ?? r.id.slice(0, 8).toUpperCase(),
        applicantName: userNames.get(r.customerId) ?? 'Unknown',
        type: r.type,
        assetName: deviceNames.get(r.deviceId) ?? '—',
        assetImageUrl: deviceImages.get(r.deviceId) ?? null,
        amountMinor: r.amountMinor ?? 0,
        currency: r.currency ?? currency,
        status: r.status,
        source: r.source ?? 'self',
        channel: r.channel ?? 'unknown',
        deviceType: r.deviceType,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // Customers (non-staff) for the admin "create application on behalf" picker.
  async customers(tenantId: string) {
    const rows = await this.prisma.user.findMany({
      where: { tenantId, isStaff: false },
      select: { id: true, fullName: true, phone: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((u) => ({ id: u.id, name: u.fullName ?? u.phone ?? '—', phone: u.phone }));
  }

  async applicationDetail(tenantId: string, id: string) {
    const app = await this.prisma.application.findFirst({ where: { tenantId, id } });
    if (!app) throw new NotFoundException('Application not found');
    const tenant = await this.tenant(tenantId);
    const currency = app.currency ?? currencyOf(tenant);

    const [customer, device, kyc, fulfilment, pastApplications, activeLoans, schedules, files] =
      await Promise.all([
        this.prisma.user.findUnique({ where: { id: app.customerId } }),
        this.prisma.device.findUnique({
          where: { id: app.deviceId },
          include: { brand: true },
        }),
        this.prisma.kycProfile.findFirst({ where: { tenantId, customerId: app.customerId } }),
        this.prisma.fulfilment.findFirst({ where: { tenantId, applicationId: app.id } }),
        this.prisma.application.count({ where: { tenantId, customerId: app.customerId } }),
        this.prisma.repaymentSchedule.count({
          where: { tenantId, customerId: app.customerId, status: 'active' },
        }),
        this.prisma.installment.findMany({
          where: { tenantId, schedule: { customerId: app.customerId } },
          select: { status: true },
        }),
        // Metadata only; the bytes come from applicationFile() one photo at a time.
        this.prisma.applicationFile.findMany({
          where: { tenantId, applicationId: app.id },
          select: { id: true, kind: true, contentType: true, sizeBytes: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

    // The serialized unit (IMEI) this customer is paying for, once handed over.
    const unit = await this.prisma.deviceUnit.findFirst({
      where: { tenantId, applicationId: app.id },
      select: { id: true, imeiLast4: true, status: true, lockState: true },
    });

    const officer = fulfilment?.agentId
      ? await this.prisma.user.findUnique({ where: { id: fulfilment.agentId } })
      : null;

    const termMonths = app.financeMonths ?? app.leaseMonths ?? null;
    const snap = (app.planSnapshot as Record<string, number> | null) ?? null;
    const requestedMinor = app.amountMinor ?? 0;
    const monthlyMinor =
      snap?.monthly ?? (termMonths ? Math.round(requestedMinor / termMonths) : 0);
    const upfrontMinor = snap?.deposit ?? 0;

    const paid = schedules.filter((i) => i.status === 'paid').length;
    const repaymentPct = schedules.length ? Math.round((paid / schedules.length) * 100) : 0;

    // Deterministic demo analytics (until a scoring service exists).
    const seed = hashString(app.id);
    const approvalProbability = 60 + (seed % 36); // 60–95
    const creditScore = 600 + (seed % 200); // 600–799
    const similarApplications = 1 + (seed % 8);
    const risk = creditScore >= 720 ? 'Low' : creditScore >= 660 ? 'Medium' : 'High';
    const tier = creditScore >= 750 ? 'Gold' : creditScore >= 680 ? 'Silver' : 'Bronze';

    return {
      id: app.id,
      reference: app.reference ?? app.id.slice(0, 8).toUpperCase(),
      status: app.status,
      type: app.type,
      currency,
      source: app.source ?? 'self',
      createdAt: app.createdAt.toISOString(),
      submittedAt: app.submittedAt?.toISOString() ?? null,
      applicant: {
        name: customer?.fullName ?? 'Unknown',
        phone: customer?.phone ?? null,
        email: customer?.email ?? null,
        idLast4: kyc?.idNumberLast4 ? `••••${kyc.idNumberLast4}` : null,
        idType: kyc?.idTypeCode ?? tenant?.idType ?? null,
        repeatClient: pastApplications > 1,
      },
      summary: {
        assetName: device?.name ?? '—',
        applicationType: TYPE_LABELS[app.type] ?? app.type,
        requestedMinor,
        monthlyMinor,
        upfrontMinor,
        termMonths,
        seller: device?.brand?.name ?? '—',
      },
      assignedOfficer: officer
        ? { name: officer.fullName ?? 'Officer', at: fulfilment?.createdAt.toISOString() ?? null }
        : null,
      timeline: buildTimeline(app.status, app.submittedAt, app.decidedAt),
      scores: { approvalProbability, risk, creditScore, similarApplications },
      files: files.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
      device: await this.chosenDevice(app, device),
      submission: await this.submission(tenantId, app, customer),
      deviceUnit: unit
        ? {
            id: unit.id,
            imeiMasked: maskImei(unit.imeiLast4),
            status: unit.status,
            lockState: unit.lockState,
          }
        : null,
      snapshot: {
        pastApplications: Math.max(0, pastApplications - 1),
        activeLoans,
        avgRepaymentScore: repaymentPct,
        avgRepaymentLabel: repaymentPct >= 80 ? 'Good' : repaymentPct >= 50 ? 'Fair' : 'Low',
        tier,
      },
    };
  }

  // The device the customer picked, with its photo (served by the website).
  private async chosenDevice(app: Application, device: { name: string; specs: unknown } | null) {
    if (!device) return null;
    const variant = app.variantId
      ? await this.prisma.deviceVariant.findUnique({ where: { id: app.variantId } })
      : null;
    return {
      name: device.name,
      imageUrl: this.imageUrl(device.specs),
      storage: variant?.storage ?? null,
      color: variant?.color ?? null,
    };
  }

  // Everything the customer entered, as labelled sections for the portal (docs/16).
  // Decrypted for staff on the application; the ID number itself stays masked.
  private async submission(
    tenantId: string,
    app: Application,
    customer: { fullName: string | null; phone: string | null; email: string | null } | null,
  ): Promise<Array<{ title: string; rows: Array<[string, string]> }>> {
    const [kyc, variant, tradeIn] = await Promise.all([
      this.kycProfiles.staffView(tenantId, app.customerId),
      app.variantId ? this.prisma.deviceVariant.findUnique({ where: { id: app.variantId } }) : null,
      app.tradeInId ? this.prisma.tradeIn.findUnique({ where: { id: app.tradeInId } }) : null,
    ]);
    const intake = app.intakeCipher
      ? this.kycProfiles.openJson<Record<string, any>>(app.intakeCipher)
      : {};
    const str = (v: unknown) => (v == null || v === '' ? '—' : String(v));
    const yesNo = (v: unknown) => (v === true ? 'Yes' : v === false ? 'No' : '—');
    const pretty = (v: unknown) =>
      v == null || v === ''
        ? '—'
        : String(v)
            .replace(/[_-]+/g, ' ')
            .replace(/^./, (c) => c.toUpperCase());
    const method = (v: unknown) =>
      v === 'momo' ? 'Mobile money' : v === 'bank' ? 'Bank account' : pretty(v);
    const sections: Array<{ title: string; rows: Array<[string, string]> }> = [];
    const add = (title: string, rows: Array<[string, string]>) => {
      const kept = rows.filter(([, v]) => v !== '—');
      if (kept.length) sections.push({ title, rows: kept });
    };

    add('Personal details', [
      ['Full name', str(customer?.fullName)],
      ['Phone', str(customer?.phone)],
      ['Email', str(customer?.email)],
      ['Date of birth', str(intake.dateOfBirth)],
      ['Residential address', str(kyc?.address?.residential)],
      ['Live location', str(kyc?.address?.liveLocation)],
    ]);
    if (kyc) {
      add('Identity', [
        ['ID type', pretty(kyc.idType)],
        ['ID number', kyc.idLast4 ? `•••• ${kyc.idLast4}` : '—'],
        ['Verification', pretty(kyc.status)],
      ]);
    }
    if (kyc?.employment) {
      add('Employment and income', [
        ['Status', str(kyc.employment.status)],
        ['Employer', str(kyc.employment.employerName)],
        ['Monthly income', str(kyc.employment.monthlyIncome)],
        ['Paid', str(kyc.employment.incomeFrequency)],
      ]);
    }
    if (intake.payout) {
      add('Payment details', [
        ['Method', method(intake.payout.method)],
        ['Provider', str(intake.payout.provider)],
        ['Account name', str(intake.payout.accountName)],
        ['Account number', str(intake.payout.account)],
      ]);
    }
    if (kyc?.guarantor) {
      const gp = intake.guarantorPayout ?? {};
      add('Guarantor', [
        ['Name', kyc.guarantor.fullName],
        ['Relationship', str(kyc.guarantor.relationship)],
        ['Phone', kyc.guarantor.phone],
        ['Address', str(kyc.guarantor.address?.text)],
        ['Payment method', method(gp.method)],
        ['Provider', str(gp.provider)],
        ['Account name', str(gp.accountName)],
        ['Account number', str(gp.account)],
      ]);
    }
    add('Device chosen', [
      ['Storage', str(variant?.storage)],
      ['Colour', str(variant?.color)],
      [
        'Plan',
        app.financeMonths
          ? `${app.financeMonths} months`
          : app.leaseMonths
            ? `${app.leaseMonths}-month lease`
            : '—',
      ],
    ]);
    if (tradeIn) {
      const acc = tradeIn.accessories as { text?: string } | null;
      add('Phone being traded in', [
        ['Brand', tradeIn.oldBrand],
        ['Model', tradeIn.oldModel],
        ['Storage', str(tradeIn.oldStorage)],
        ['Condition', pretty(tradeIn.conditionCode)],
        ['Accessories', str(acc?.text)],
        ['Notes', str(tradeIn.notes)],
      ]);
    }
    if (intake.fulfilment) {
      add('Pickup or delivery', [
        ['Method', intake.fulfilment.method === 'delivery' ? 'Delivery' : 'Pickup at a branch'],
        ['Region', str(intake.fulfilment.region)],
        [
          intake.fulfilment.method === 'delivery' ? 'Address' : 'Branch',
          str(intake.fulfilment.detail),
        ],
      ]);
    }
    if (intake.consents) {
      const labels: Record<string, string> = {
        terms: 'Terms accepted',
        creditCheck: 'Credit check allowed',
        dataProcessing: 'Data processing allowed',
        leaseTerms: 'Lease terms accepted',
        returnConditions: 'Return conditions accepted',
        tradeTerms: 'Trade-in terms accepted',
      };
      add(
        'Consents',
        Object.entries(intake.consents as Record<string, unknown>).map(
          ([k, v]) => [labels[k] ?? pretty(k), yesNo(v)] as [string, string],
        ),
      );
    }
    return sections;
  }

  // Where requests come from over the last `days` (docs/19): applications + buy now orders.
  async channelAnalytics(tenantId: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [apps, orders] = await Promise.all([
      this.prisma.application.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: { type: true, channel: true, deviceType: true, createdAt: true },
      }),
      this.prisma.order.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: { channel: true, deviceType: true, createdAt: true },
      }),
    ]);
    return summariseOrigins(
      [
        ...apps.map((a) => ({
          category: a.type,
          channel: a.channel,
          deviceType: a.deviceType,
          createdAt: a.createdAt,
        })),
        ...orders.map((o) => ({
          category: 'orders' as const,
          channel: o.channel,
          deviceType: o.deviceType,
          createdAt: o.createdAt,
        })),
      ],
      days,
    );
  }

  // A website photo (ID, selfie, trade-in). Every view is audited: it's identity data.
  async applicationFile(tenantId: string, applicationId: string, fileId: string) {
    const file = await this.prisma.applicationFile.findFirst({
      where: { id: fileId, tenantId, applicationId },
    });
    if (!file) throw new NotFoundException('File not found');
    await this.audit(tenantId, 'application.file_viewed', 'application_file', file.id);
    return file;
  }

  // --- User detail --------------------------------------------------------
  async userDetail(tenantId: string, id: string) {
    const tenant = await this.tenant(tenantId);
    const user = await this.prisma.user.findFirst({
      where: { tenantId, id },
      include: { roles: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const role = primaryRole(user.roles.map((r) => r.role));
    // Recent tenant activity as a stand-in for per-user activity (audit logs are
    // not yet actor-linked in seed data).
    const activity = await this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      id: user.id,
      name: user.fullName ?? '—',
      email: user.email ?? null,
      phone: user.phone ?? null,
      role,
      country: tenant?.country ?? '—',
      status: user.status,
      isStaff: user.isStaff,
      // Staff can sign in once they have a password; TOTP is set up at first sign-in.
      signIn: user.isStaff
        ? user.passwordHash
          ? user.totpEnabledAt
            ? 'ready'
            : 'invited'
          : 'not_set_up'
        : null,
      department: DEPARTMENT_FOR[role] ?? 'Operations',
      permissions: PERMISSIONS_FOR[role] ?? ['Read'],
      // Delegated admins: their level per area; null for every other role.
      adminAccess: user.roles.some((r) => r.role === Role.admin)
        ? normalizePermissions(user.permissions)
        : null,
      recentActivity: activity.map((a) => ({
        id: a.id,
        at: a.createdAt.toISOString(),
        resource: a.entity,
        action: a.action,
        status: 'success',
      })),
    };
  }

  // --- Users --------------------------------------------------------------
  async users(tenantId: string) {
    const tenant = await this.tenant(tenantId);
    const rows = await this.prisma.user.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { roles: true },
    });
    const staff = rows.filter((u) => u.isStaff).length;
    return {
      stats: {
        total: rows.length,
        active: rows.filter((u) => u.status === 'active').length,
        staff,
        customers: rows.length - staff,
      },
      rows: rows.map((u) => ({
        id: u.id,
        name: u.fullName ?? '—',
        contact: u.email ?? u.phone ?? '—',
        role: primaryRole(u.roles.map((r) => r.role)),
        country: tenant?.country ?? '—',
        status: u.status,
        ...(u.roles.some((r) => r.role === Role.admin)
          ? { adminAccess: normalizePermissions(u.permissions) }
          : {}),
      })),
    };
  }

  // --- KYC ----------------------------------------------------------------
  async kyc(tenantId: string) {
    const tenant = await this.tenant(tenantId);
    const [profiles, byStatus] = await Promise.all([
      this.prisma.kycProfile.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.kycProfile.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);
    const { userNames } = await this.resolveNames(
      profiles.map((p) => p.customerId),
      [],
    );
    const users = await this.prisma.user.findMany({
      where: { tenantId, id: { in: profiles.map((p) => p.customerId) } },
      select: { id: true, phone: true, email: true },
    });
    const contactById = new Map(users.map((u) => [u.id, u.email ?? u.phone ?? '—']));
    const stat = (s: string) =>
      byStatus.filter((r) => r.status === s).reduce((n, r) => n + r._count._all, 0);

    return {
      stats: {
        total: profiles.length,
        verified: stat('verified'),
        pending: stat('pending'),
        rejected: stat('rejected'),
      },
      idType: tenant?.idType ?? 'National ID',
      rows: profiles.map((p) => ({
        id: p.id,
        customerName: userNames.get(p.customerId) ?? 'Unknown',
        contact: contactById.get(p.customerId) ?? '—',
        idType: p.idTypeCode ?? tenant?.idType ?? '—',
        idLast4: p.idNumberLast4 ? `••••${p.idNumberLast4}` : '—',
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  async kycDetail(tenantId: string, id: string) {
    const tenant = await this.tenant(tenantId);
    const profile = await this.prisma.kycProfile.findFirst({
      where: { tenantId, id },
      include: { documents: true, guarantor: true },
    });
    if (!profile) throw new NotFoundException('KYC profile not found');

    const [customer, applicationsCount, activeLoans] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: profile.customerId } }),
      this.prisma.application.count({ where: { tenantId, customerId: profile.customerId } }),
      this.prisma.repaymentSchedule.count({
        where: { tenantId, customerId: profile.customerId, status: 'active' },
      }),
    ]);

    return {
      id: profile.id,
      status: profile.status,
      idType: profile.idTypeCode ?? tenant?.idType ?? '—',
      idLast4: profile.idNumberLast4 ? `••••${profile.idNumberLast4}` : '—',
      createdAt: profile.createdAt.toISOString(),
      reviewedAt: profile.reviewedAt?.toISOString() ?? null,
      rejectReason: profile.rejectReason ?? null,
      customer: {
        name: customer?.fullName ?? 'Unknown',
        phone: customer?.phone ?? null,
        email: customer?.email ?? null,
      },
      guarantor: profile.guarantor ? { relationship: profile.guarantor.relationship } : null,
      documents: profile.documents.map((d) => ({ kind: d.kind, status: d.status })),
      applicationsCount,
      activeLoans,
    };
  }

  // --- Product Inventory / POS -------------------------------------------
  async inventory(tenantId: string) {
    const tenant = await this.tenant(tenantId);
    const devices = await this.prisma.device.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { brand: true, category: true, variants: true },
    });
    const rows = devices.map((d) => {
      const stock = d.variants.reduce((s, v) => s + v.stockQty, 0);
      return {
        id: d.id,
        name: d.name,
        brand: d.brand.name,
        category: d.category.name,
        priceMinor: d.cashPriceMinor,
        currency: d.currency,
        stock,
        variants: d.variants.length,
        status: d.status,
        financeEligible: d.financeEligible,
        leaseEligible: d.leaseEligible,
        tradeInEligible: d.tradeInEligible,
        featured: d.featured,
        promoLabel: d.promoLabel,
        promoPriceMinor: d.promoPriceMinor,
      };
    });
    return {
      currency: currencyOf(tenant),
      stats: {
        total: rows.length,
        published: rows.filter((r) => r.status === 'published').length,
        featured: rows.filter((r) => r.featured).length,
        onPromo: rows.filter((r) => r.promoLabel).length,
        outOfStock: rows.filter((r) => r.stock === 0).length,
        inventoryValueMinor: devices.reduce(
          (s, d) => s + d.cashPriceMinor * d.variants.reduce((a, v) => a + v.stockQty, 0),
          0,
        ),
      },
      rows,
    };
  }

  async inventoryDetail(tenantId: string, id: string) {
    const d = await this.prisma.device.findFirst({
      where: { tenantId, id },
      include: {
        brand: true,
        category: true,
        variants: { orderBy: { createdAt: 'asc' } },
        media: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!d) throw new NotFoundException('Product not found');
    return {
      id: d.id,
      slug: d.slug,
      name: d.name,
      brand: d.brand.name,
      category: d.category.name,
      summary: d.summary ?? null,
      priceMinor: d.cashPriceMinor,
      currency: d.currency,
      status: d.status,
      financeEligible: d.financeEligible,
      leaseEligible: d.leaseEligible,
      tradeInEligible: d.tradeInEligible,
      featured: d.featured,
      promoLabel: d.promoLabel,
      promoPriceMinor: d.promoPriceMinor,
      totalStock: d.variants.reduce((s, v) => s + v.stockQty, 0),
      // Images are listed but can't be uploaded until real object storage is wired.
      media: d.media.map((m) => ({
        id: m.id,
        url: this.storage.signedGet(m.s3Key),
        isPrimary: m.isPrimary,
      })),
      variants: d.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        storage: v.storage,
        color: v.color,
        priceDeltaMinor: v.priceDeltaMinor,
        priceMinor: d.cashPriceMinor + v.priceDeltaMinor,
        stockQty: v.stockQty,
        isActive: v.isActive,
      })),
    };
  }

  // --- Branch Management --------------------------------------------------
  async branches(tenantId: string) {
    const rows = await this.prisma.branch.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    const managerIds = rows.map((b) => b.managerId).filter((x): x is string => !!x);
    const [managers, byBranch] = await Promise.all([
      managerIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: managerIds } },
            select: { id: true, fullName: true },
          })
        : Promise.resolve([]),
      this.prisma.fulfilment.groupBy({
        by: ['branchId'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);
    const managerById = new Map(managers.map((m) => [m.id, m.fullName ?? '—']));
    const fulfilmentByBranch = new Map(byBranch.map((f) => [f.branchId, f._count._all]));
    return {
      stats: {
        total: rows.length,
        active: rows.filter((b) => b.status === 'active').length,
        stores: rows.filter((b) => b.type === 'store').length,
        partners: rows.filter((b) => b.type === 'partner' || b.type === 'pickup_point').length,
      },
      rows: rows.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type,
        city: b.city ?? '—',
        region: b.region ?? '—',
        status: b.status,
        manager: b.managerId ? (managerById.get(b.managerId) ?? '—') : null,
        fulfilments: fulfilmentByBranch.get(b.id) ?? 0,
      })),
    };
  }

  async branchDetail(tenantId: string, id: string) {
    const b = await this.prisma.branch.findFirst({ where: { tenantId, id } });
    if (!b) throw new NotFoundException('Branch not found');
    const [manager, fulfilments] = await Promise.all([
      b.managerId
        ? this.prisma.user.findUnique({
            where: { id: b.managerId },
            select: { id: true, fullName: true, email: true },
          })
        : Promise.resolve(null),
      this.prisma.fulfilment.count({ where: { tenantId, branchId: b.id } }),
    ]);
    return {
      id: b.id,
      name: b.name,
      type: b.type,
      city: b.city ?? '—',
      region: b.region ?? '—',
      address: b.address ?? '—',
      phone: b.phone ?? '—',
      status: b.status,
      createdAt: b.createdAt.toISOString(),
      manager: manager
        ? { id: manager.id, name: manager.fullName ?? '—', email: manager.email }
        : null,
      fulfilments,
    };
  }

  // Staff eligible to manage a branch (Branch Admins).
  async branchAdmins(tenantId: string) {
    const users = await this.prisma.user.findMany({
      where: { tenantId, isStaff: true, roles: { some: { role: Role.country_manager } } },
      select: { id: true, fullName: true, email: true },
      orderBy: { fullName: 'asc' },
    });
    return users.map((u) => ({ id: u.id, name: u.fullName ?? u.email ?? '—' }));
  }

  async assignBranchAdmin(tenantId: string, id: string, userId: string) {
    const branch = await this.prisma.branch.findFirst({ where: { tenantId, id } });
    if (!branch) throw new NotFoundException('Branch not found');
    const user = await this.prisma.user.findFirst({ where: { tenantId, id: userId } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.branch.update({ where: { id }, data: { managerId: userId } });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        actorRole: 'super_admin',
        action: 'branch.admin_assigned',
        entity: 'branch',
        entityId: id,
      },
    });
    return this.branchDetail(tenantId, id);
  }

  // --- Activity log -------------------------------------------------------
  async activityLog(tenantId: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const actorIds = rows.map((r) => r.actorId).filter((x): x is string => !!x);
    const users = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName ?? '—']));
    return {
      rows: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        user: actorLabel(r.actorId, r.actorRole, nameById),
        role: r.actorRole ?? 'system',
        resource: r.entity,
        action: r.action,
        ip: r.ip ?? '—',
      })),
    };
  }

  // --- Payments (Transactions) -------------------------------------------
  // --- Store agents & pickups ----------------------------------------------
  // Agents with their outlet and pickup workload (an agent works at one outlet).
  async agents(tenantId: string) {
    const [users, branches, pending, done30] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId, roles: { some: { role: Role.agent } } },
        include: { roles: { where: { role: Role.agent } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.branch.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      this.prisma.fulfilment.groupBy({
        by: ['branchId'],
        where: { tenantId, status: 'pending' },
        _count: { _all: true },
      }),
      this.prisma.fulfilment.groupBy({
        by: ['agentId'],
        where: {
          tenantId,
          status: 'fulfilled',
          fulfilledAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        _count: { _all: true },
      }),
    ]);
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const pendingByBranch = new Map(pending.map((p) => [p.branchId, p._count._all]));
    const doneByAgent = new Map(done30.map((d) => [d.agentId, d._count._all]));
    const rows = users.map((u) => {
      const branchId = u.roles[0]?.branchId ?? null;
      return {
        id: u.id,
        name: u.fullName ?? '—',
        contact: u.email ?? u.phone ?? '—',
        status: u.status,
        branchId,
        branchName: branchId ? (branchName.get(branchId) ?? '—') : null,
        pendingAtOutlet: branchId ? (pendingByBranch.get(branchId) ?? 0) : 0,
        handedOver30d: doneByAgent.get(u.id) ?? 0,
        signIn: u.passwordHash ? (u.totpEnabledAt ? 'ready' : 'invited') : 'not_set_up',
      };
    });
    return {
      stats: {
        total: rows.length,
        active: rows.filter((r) => r.status === 'active').length,
        assigned: rows.filter((r) => r.branchId).length,
        unassigned: rows.filter((r) => !r.branchId).length,
        handedOver30d: rows.reduce((n, r) => n + r.handedOver30d, 0),
      },
      rows,
    };
  }

  // The device pickup queue: approved plans waiting at an outlet, and handovers done.
  async pickups(tenantId: string) {
    const rows = await this.prisma.fulfilment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const appIds = rows.map((r) => r.applicationId);
    const [apps, branches, agents] = await Promise.all([
      this.prisma.application.findMany({
        where: { id: { in: appIds } },
        select: { id: true, reference: true, customerId: true, deviceId: true, type: true },
      }),
      this.prisma.branch.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      this.prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.agentId).filter((x): x is string => !!x) } },
        select: { id: true, fullName: true },
      }),
    ]);
    const appById = new Map(apps.map((a) => [a.id, a]));
    const [customers, devices] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: apps.map((a) => a.customerId) } },
        select: { id: true, fullName: true, phone: true },
      }),
      this.prisma.device.findMany({
        where: { id: { in: apps.map((a) => a.deviceId) } },
        select: { id: true, name: true },
      }),
    ]);
    const customer = new Map(customers.map((c) => [c.id, c]));
    const device = new Map(devices.map((d) => [d.id, d.name]));
    const branch = new Map(branches.map((b) => [b.id, b.name]));
    const agent = new Map(agents.map((a) => [a.id, a.fullName ?? '—']));
    const now = Date.now();
    const out = rows.map((r) => {
      const a = appById.get(r.applicationId);
      const c = a ? customer.get(a.customerId) : undefined;
      return {
        id: r.id,
        applicationId: r.applicationId,
        reference: a?.reference ?? r.applicationId.slice(0, 8).toUpperCase(),
        type: a?.type ?? '—',
        customerName: c?.fullName ?? 'Unknown',
        phone: c?.phone ?? null,
        assetName: (a && device.get(a.deviceId)) ?? '—',
        branchName: branch.get(r.branchId) ?? '—',
        agentName: r.agentId ? (agent.get(r.agentId) ?? '—') : null,
        status: r.status,
        idVerified: r.idVerified,
        imei: r.imeiLast4 ? maskImei(r.imeiLast4) : null,
        waitingDays:
          r.status === 'pending' ? Math.floor((now - r.createdAt.getTime()) / 86_400_000) : null,
        createdAt: r.createdAt.toISOString(),
        fulfilledAt: r.fulfilledAt?.toISOString() ?? null,
      };
    });
    return {
      stats: {
        pending: out.filter((r) => r.status === 'pending').length,
        waitingOver3Days: out.filter((r) => (r.waitingDays ?? 0) > 3).length,
        fulfilled: out.filter((r) => r.status === 'fulfilled').length,
        cancelled: out.filter((r) => r.status === 'cancelled').length,
      },
      rows: out,
    };
  }

  // --- Collections & Recovery ----------------------------------------------
  // Read-only arrears view with PAR ageing (days past due). Unlike GET /admin/arrears
  // it never flips statuses or sends reminders, so opening the page has no effects.
  async collections(tenantId: string) {
    const tenant = await this.tenant(tenantId);
    const currency = currencyOf(tenant);
    const now = new Date();
    const late = await this.prisma.installment.findMany({
      where: {
        tenantId,
        OR: [{ status: 'overdue' }, { status: 'due', dueDate: { lt: now } }],
      },
      include: {
        schedule: { select: { applicationId: true, customerId: true, currency: true, kind: true } },
      },
      orderBy: { dueDate: 'asc' },
    });
    const customerIds = [...new Set(late.map((i) => i.schedule.customerId))];
    const applicationIds = [...new Set(late.map((i) => i.schedule.applicationId))];
    const [customers, applications] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, fullName: true, phone: true },
      }),
      this.prisma.application.findMany({
        where: { id: { in: applicationIds } },
        select: { id: true, reference: true, deviceId: true },
      }),
    ]);
    const devices = await this.prisma.device.findMany({
      where: { id: { in: applications.map((a) => a.deviceId) } },
      select: { id: true, name: true },
    });
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const appById = new Map(applications.map((a) => [a.id, a]));
    const deviceName = new Map(devices.map((d) => [d.id, d.name]));

    const rows = late.map((i) => {
      const daysOverdue = Math.max(
        1,
        Math.floor((now.getTime() - i.dueDate.getTime()) / 86_400_000),
      );
      const app = appById.get(i.schedule.applicationId);
      const customer = customerById.get(i.schedule.customerId);
      return {
        id: i.id,
        scheduleId: i.scheduleId,
        applicationId: i.schedule.applicationId,
        reference: app?.reference ?? i.schedule.applicationId.slice(0, 8).toUpperCase(),
        customerId: i.schedule.customerId,
        customerName: customer?.fullName ?? 'Unknown',
        phone: customer?.phone ?? null,
        assetName: (app && deviceName.get(app.deviceId)) ?? '—',
        kind: i.schedule.kind,
        installment: i.isDeposit ? 'Deposit' : `#${i.seq}`,
        dueDate: i.dueDate.toISOString(),
        daysOverdue,
        bucket: parBucket(daysOverdue),
        amountDueMinor: i.amountMinor - i.paidAmountMinor,
        currency: i.schedule.currency,
      };
    });
    const sum = (b?: string) =>
      rows.filter((r) => !b || r.bucket === b).reduce((n, r) => n + r.amountDueMinor, 0);
    const count = (b: string) => rows.filter((r) => r.bucket === b).length;
    return {
      currency,
      stats: {
        overdueInstallments: rows.length,
        customersInArrears: new Set(rows.map((r) => r.customerId)).size,
        overdueMinor: sum(),
        par1to30Minor: sum('1-30'),
        par31to60Minor: sum('31-60'),
        par61to90Minor: sum('61-90'),
        par90plusMinor: sum('90+'),
        par1to30: count('1-30'),
        par31to60: count('31-60'),
        par61to90: count('61-90'),
        par90plus: count('90+'),
      },
      rows,
    };
  }

  // Money-in ledger: deposits, installments and lease fees. (Merchant
  // disbursements are money-out and are not modelled yet — see
  // docs/features/10-merchant-disbursements.md.)
  async payments(tenantId: string) {
    const tenant = await this.tenant(tenantId);
    const currency = currencyOf(tenant);

    const [rowsRaw, byPurpose, byStatus] = await Promise.all([
      this.prisma.payment.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.payment.groupBy({
        by: ['purpose'],
        where: { tenantId, status: PaymentStatus.succeeded },
        _sum: { amountMinor: true },
      }),
      this.prisma.payment.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);

    const sumFor = (p: PaymentPurpose) =>
      byPurpose.find((r) => r.purpose === p)?._sum.amountMinor ?? 0;
    const countFor = (s: Array<PaymentStatus>) =>
      byStatus.filter((r) => s.includes(r.status)).reduce((n, r) => n + r._count._all, 0);

    const { userNames } = await this.resolveNames(
      rowsRaw.map((r) => r.customerId),
      [],
    );

    return {
      currency,
      stats: {
        collectedMinor:
          sumFor(PaymentPurpose.deposit) +
          sumFor(PaymentPurpose.installment) +
          sumFor(PaymentPurpose.lease_fee),
        depositMinor: sumFor(PaymentPurpose.deposit),
        installmentMinor: sumFor(PaymentPurpose.installment),
        feeMinor: sumFor(PaymentPurpose.lease_fee),
        pending: countFor([PaymentStatus.initiated, PaymentStatus.pending]),
        failed: countFor([PaymentStatus.failed, PaymentStatus.reversed]),
      },
      rows: rowsRaw.map((r) => ({
        id: r.id,
        reference: r.id.slice(0, 8).toUpperCase(),
        customerName: userNames.get(r.customerId) ?? 'Unknown',
        purpose: r.purpose,
        channel: r.channel,
        provider: r.provider,
        amountMinor: r.amountMinor,
        currency: r.currency ?? currency,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async paymentDetail(tenantId: string, id: string) {
    const p = await this.prisma.payment.findFirst({
      where: { id, tenantId },
      include: { receipt: true, ledger: true, installment: true },
    });
    if (!p) throw new NotFoundException('Payment not found');
    const { userNames } = await this.resolveNames([p.customerId], []);
    return {
      id: p.id,
      reference: p.id.slice(0, 8).toUpperCase(),
      status: p.status,
      purpose: p.purpose,
      channel: p.channel,
      provider: p.provider,
      amountMinor: p.amountMinor,
      currency: p.currency,
      providerRef: p.providerRef,
      failureReason: p.failureReason,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      customer: { name: userNames.get(p.customerId) ?? 'Unknown' },
      applicationId: p.applicationId,
      receipt: p.receipt
        ? { number: p.receipt.number, issuedAt: p.receipt.issuedAt.toISOString() }
        : null,
      installment: p.installment
        ? {
            seq: p.installment.seq,
            dueDate: p.installment.dueDate.toISOString(),
            status: p.installment.status,
          }
        : null,
      ledger: p.ledger.map((l) => ({
        account: l.account,
        direction: l.direction,
        amountMinor: l.amountMinor,
        currency: l.currency,
        memo: l.memo,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  // --- Mutations ----------------------------------------------------------
  // Records who took the action from the request context (actor headers set by
  // the portal; real staff auth will populate the same fields via req.user).
  private async audit(tenantId: string, action: string, entity: string, entityId?: string) {
    const ctx = getContext();
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        actorId: ctx?.userId ?? null,
        actorRole: ctx?.roles?.[0] ?? 'system',
        action,
        entity,
        entityId,
      },
    });
  }

  private actorId(): string | null {
    return getContext()?.userId ?? null;
  }

  async createApplication(
    tenantId: string,
    dto: {
      customerId: string;
      deviceId: string;
      type: 'financing' | 'lease' | 'trade_in';
      amountMinor: number;
      termMonths?: number;
      mode?: 'self' | 'admin';
    },
  ) {
    const tenant = await this.tenant(tenantId);
    const [customer, device] = await Promise.all([
      this.prisma.user.findFirst({ where: { tenantId, id: dto.customerId } }),
      this.prisma.device.findFirst({ where: { tenantId, id: dto.deviceId } }),
    ]);
    if (!customer) throw new NotFoundException('Customer not found');
    if (!device) throw new NotFoundException('Product not found');

    const prefix = dto.type === 'financing' ? 'BNP' : dto.type === 'lease' ? 'LSE' : 'TRD';
    const app = await this.prisma.application.create({
      data: {
        tenantId,
        customerId: dto.customerId,
        deviceId: dto.deviceId,
        type: dto.type,
        status: 'submitted',
        amountMinor: dto.amountMinor,
        currency: currencyOf(tenant),
        financeMonths: dto.type === 'financing' ? (dto.termMonths ?? null) : null,
        leaseMonths: dto.type === 'lease' ? (dto.termMonths ?? null) : null,
        reference: `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        submittedAt: new Date(),
        source: dto.mode === 'self' ? 'self' : 'admin',
        channel: 'portal',
        createdById: this.actorId(),
      },
    });
    await this.audit(tenantId, 'application.created_by_admin', 'application', app.id);
    return { id: app.id };
  }

  async decideApplication(
    tenantId: string,
    id: string,
    decision: 'approve' | 'reject',
    reason?: string,
  ) {
    const app = await this.prisma.application.findFirst({ where: { tenantId, id } });
    if (!app) throw new NotFoundException('Application not found');
    const status = decision === 'approve' ? ApplicationStatus.approved : ApplicationStatus.declined;
    await this.prisma.application.update({
      where: { id },
      data: {
        status,
        decidedAt: new Date(),
        declineReason: decision === 'reject' ? (reason ?? null) : null,
      },
    });
    await this.audit(
      tenantId,
      `application.${decision === 'approve' ? 'approved' : 'declined'}`,
      'application',
      id,
    );
    return this.applicationDetail(tenantId, id);
  }

  async decideKyc(tenantId: string, id: string, decision: 'verify' | 'reject', reason?: string) {
    const profile = await this.prisma.kycProfile.findFirst({ where: { tenantId, id } });
    if (!profile) throw new NotFoundException('KYC profile not found');
    await this.prisma.kycProfile.update({
      where: { id },
      data: {
        status: decision === 'verify' ? 'verified' : 'rejected',
        reviewedAt: new Date(),
        rejectReason: decision === 'reject' ? (reason ?? null) : null,
      },
    });
    await this.audit(
      tenantId,
      `kyc.${decision === 'verify' ? 'verified' : 'rejected'}`,
      'kyc_profile',
      id,
    );
    return this.kycDetail(tenantId, id);
  }

  // Staff sign in with email + password + TOTP, so a staff account gets a one-time
  // password here, returned once for the admin to share. Customers use phone OTP.
  async createUser(
    tenantId: string,
    dto: {
      name: string;
      email?: string;
      phone?: string;
      role: string;
      status?: string;
      adminAccess?: unknown;
    },
    actorRoles: string[],
  ) {
    const role = enumRole(dto.role);
    assertCanGrant(actorRoles, [role]);
    const adminAccess =
      role === Role.admin ? await this.adminAccessFor(tenantId, dto.adminAccess) : null;
    const isStaff = role !== Role.customer;
    const email = dto.email?.trim().toLowerCase() || null;
    if (isStaff && !email) throw new BadRequestException('Staff need an email address to sign in');
    if (email && (await this.prisma.user.findFirst({ where: { tenantId, email } }))) {
      throw new ConflictException('A user with that email already exists in this country');
    }
    const user = await this.prisma.user.create({
      data: {
        tenantId,
        fullName: dto.name,
        email,
        phone: dto.phone || null,
        isStaff,
        status: dto.status === 'suspended' ? 'suspended' : 'active',
        permissions: adminAccess ?? undefined,
        roles: { create: [{ tenantId, role }] },
      },
    });
    await this.audit(tenantId, 'user.created', 'user', user.id);
    // Staff get an invite link (emailed when mail is set up); a suspended account
    // gets one later, from "Reset sign-in".
    if (isStaff && email && user.status === 'active') {
      return { id: user.id, email, invite: await this.inviteStaff(tenantId, user, 'new') };
    }
    return { id: user.id };
  }

  private async inviteStaff(
    tenantId: string,
    user: { id: string; email: string | null; fullName: string | null },
    reason: 'new' | 'reset',
  ) {
    const actorId = this.actorId();
    // The inviter may live in HQ, outside this country's RLS scope; then no name.
    const inviter = actorId
      ? await this.prisma.user.findFirst({ where: { id: actorId }, select: { fullName: true } })
      : null;
    return this.invites.invite(
      tenantId,
      { id: user.id, email: user.email!, fullName: user.fullName },
      { invitedBy: inviter?.fullName ?? null, reason },
    );
  }

  // A delegated admin lives in HQ (they work across countries) and needs at least
  // one area; anything outside the known areas is dropped by normalizePermissions.
  private async adminAccessFor(tenantId: string, input: unknown): Promise<AdminPermissions> {
    const tenant = await this.tenant(tenantId);
    if (tenant?.isCountry !== false) {
      throw new BadRequestException('Admins are created in HQ, not in a country');
    }
    const access = normalizePermissions(input);
    if (Object.keys(access).length === 0) {
      throw new BadRequestException('Give the admin access to at least one area');
    }
    return access;
  }

  // New invite link; the old password, two-factor and recovery codes stop working
  // and the user is signed out everywhere. For a lost phone or a forgotten password.
  async resetSignIn(tenantId: string, id: string, actorRoles: string[]) {
    const user = await this.manageableUser(tenantId, id, actorRoles);
    if (!user.isStaff) throw new BadRequestException('Customers sign in with a phone code');
    if (!user.email) throw new BadRequestException('Add an email address first');
    if (user.status === 'suspended') throw new BadRequestException('Reactivate this user first');
    const invite = await this.inviteStaff(tenantId, user, 'reset');
    await this.audit(tenantId, 'user.sign_in_reset', 'user', id);
    return { id, email: user.email, invite };
  }

  async updateUser(
    tenantId: string,
    id: string,
    dto: {
      name?: string;
      email?: string;
      phone?: string;
      role?: string;
      status?: string;
      adminAccess?: unknown;
    },
    actorRoles: string[],
  ) {
    if (dto.role) assertCanGrant(actorRoles, [enumRole(dto.role)]);
    const before = await this.manageableUser(tenantId, id, actorRoles);
    const nextRole = dto.role ? enumRole(dto.role) : null;
    const isAdmin = nextRole
      ? nextRole === Role.admin
      : before.roles.some((r) => r.role === Role.admin);
    // Only a Super Admin changes what an admin can reach (manageableUser already
    // refuses everyone else, since only they can grant the admin role).
    const adminAccess =
      isAdmin && (dto.adminAccess !== undefined || nextRole === Role.admin)
        ? await this.adminAccessFor(tenantId, dto.adminAccess ?? before.permissions)
        : null;
    const becomesStaff = !!dto.role && enumRole(dto.role) !== Role.customer;
    if (becomesStaff && !(dto.email ?? before.email)) {
      throw new BadRequestException('Staff need an email address to sign in');
    }
    await this.prisma.user.update({
      where: { id },
      data: {
        fullName: dto.name ?? undefined,
        email: dto.email ?? undefined,
        phone: dto.phone ?? undefined,
        status:
          dto.status === 'suspended' ? 'suspended' : dto.status === 'active' ? 'active' : undefined,
        // Set for admins; cleared when someone stops being one.
        permissions: adminAccess ?? (isAdmin ? undefined : Prisma.DbNull),
      },
    });
    if (adminAccess) {
      await this.audit(tenantId, 'user.admin_access_changed', 'user', id);
    }
    if (dto.role) {
      const role = enumRole(dto.role);
      await this.prisma.userRole.deleteMany({ where: { userId: id } });
      await this.prisma.userRole.create({ data: { userId: id, tenantId, role } });
      await this.prisma.user.update({ where: { id }, data: { isStaff: role !== Role.customer } });
    }
    await this.audit(tenantId, 'user.updated', 'user', id);
    // A customer promoted to staff has no sign-in yet: send them an invite.
    if (becomesStaff && !before.passwordHash) {
      const email = dto.email ?? before.email;
      const invite = await this.inviteStaff(tenantId, { ...before, email }, 'new');
      return { id, email, invite };
    }
    return { id };
  }

  async setUserStatus(
    tenantId: string,
    id: string,
    status: 'active' | 'suspended',
    actorRoles: string[],
  ) {
    await this.manageableUser(tenantId, id, actorRoles);
    await this.prisma.user.update({ where: { id }, data: { status } });
    await this.audit(
      tenantId,
      `user.${status === 'suspended' ? 'suspended' : 'activated'}`,
      'user',
      id,
    );
    return { id };
  }

  async deleteUser(tenantId: string, id: string, actorRoles: string[]) {
    await this.manageableUser(tenantId, id, actorRoles);
    await this.prisma.user.delete({ where: { id } });
    await this.audit(tenantId, 'user.deleted', 'user', id);
    return { id };
  }

  // A Country Manager can't edit, suspend or delete a peer manager or a Super Admin.
  private async manageableUser(tenantId: string, id: string, actorRoles: string[]) {
    const user = await this.prisma.user.findFirst({
      where: { tenantId, id },
      include: { roles: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.roles.every((r) => canGrant(actorRoles, r.role))) {
      throw new ForbiddenException("You can't change this user");
    }
    return user;
  }

  async createProduct(
    tenantId: string,
    dto: {
      name: string;
      brand: string;
      category: string;
      priceMinor: number;
      stock?: number;
      status?: string;
      financeEligible?: boolean;
      leaseEligible?: boolean;
      tradeInEligible?: boolean;
      featured?: boolean;
      promoLabel?: string;
      promoPriceMinor?: number;
    },
  ) {
    const tenant = await this.tenant(tenantId);
    const slugify = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    const brand = await this.prisma.brand.upsert({
      where: { tenantId_slug: { tenantId, slug: slugify(dto.brand) } },
      update: { name: dto.brand },
      create: { tenantId, name: dto.brand, slug: slugify(dto.brand) },
    });
    const category = await this.prisma.category.upsert({
      where: { tenantId_slug: { tenantId, slug: slugify(dto.category) } },
      update: { name: dto.category },
      create: { tenantId, name: dto.category, slug: slugify(dto.category) },
    });
    const device = await this.prisma.device.create({
      data: {
        tenantId,
        brandId: brand.id,
        categoryId: category.id,
        name: dto.name,
        slug: `${slugify(dto.name)}-${Date.now().toString(36)}`,
        cashPriceMinor: dto.priceMinor,
        currency: currencyOf(tenant),
        status: dto.status === 'published' ? 'published' : 'draft',
        publishedAt: dto.status === 'published' ? new Date() : null,
        financeEligible: dto.financeEligible ?? true,
        leaseEligible: dto.leaseEligible ?? false,
        tradeInEligible: dto.tradeInEligible ?? false,
        featured: dto.featured ?? false,
        promoLabel: dto.promoLabel || null,
        promoPriceMinor: dto.promoPriceMinor ?? null,
        variants: {
          create: [
            {
              tenantId,
              sku: `${dto.name.slice(0, 3).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
              stockQty: dto.stock ?? 0,
            },
          ],
        },
      },
    });
    await this.audit(tenantId, 'device.created', 'device', device.id);
    return { id: device.id };
  }

  async updateProduct(
    tenantId: string,
    id: string,
    dto: {
      name?: string;
      priceMinor?: number;
      status?: string;
      financeEligible?: boolean;
      leaseEligible?: boolean;
      tradeInEligible?: boolean;
      featured?: boolean;
      promoLabel?: string | null;
      promoPriceMinor?: number | null;
    },
  ) {
    const device = await this.prisma.device.findFirst({
      where: { tenantId, id },
      include: { variants: { where: { isActive: true }, select: { id: true } } },
    });
    if (!device) throw new NotFoundException('Product not found');
    // Same rule as the catalog publish endpoint: something must be buyable.
    if (dto.status === 'published' && device.variants.length === 0) {
      throw new BadRequestException('Add at least one available variant before publishing');
    }
    await this.prisma.device.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        cashPriceMinor: dto.priceMinor ?? undefined,
        status:
          dto.status === 'published' ? 'published' : dto.status === 'draft' ? 'draft' : undefined,
        financeEligible: dto.financeEligible ?? undefined,
        leaseEligible: dto.leaseEligible ?? undefined,
        tradeInEligible: dto.tradeInEligible ?? undefined,
        featured: dto.featured ?? undefined,
        promoLabel: dto.promoLabel === undefined ? undefined : dto.promoLabel || null,
        promoPriceMinor: dto.promoPriceMinor === undefined ? undefined : dto.promoPriceMinor,
      },
    });
    await this.audit(tenantId, 'device.updated', 'device', id);
    return { id };
  }

  async deleteProduct(tenantId: string, id: string) {
    const device = await this.prisma.device.findFirst({ where: { tenantId, id } });
    if (!device) throw new NotFoundException('Product not found');
    await this.prisma.device.delete({ where: { id } });
    await this.audit(tenantId, 'device.deleted', 'device', id);
    return { id };
  }

  async createBranch(
    tenantId: string,
    dto: {
      name: string;
      type?: string;
      city?: string;
      region?: string;
      address?: string;
      phone?: string;
      status?: string;
    },
  ) {
    const branch = await this.prisma.branch.create({
      data: {
        tenantId,
        name: dto.name,
        type: (dto.type as never) ?? 'store',
        city: dto.city || null,
        region: dto.region || null,
        address: dto.address || null,
        phone: dto.phone || null,
        status: dto.status === 'inactive' ? 'inactive' : 'active',
      },
    });
    await this.audit(tenantId, 'branch.created', 'branch', branch.id);
    return { id: branch.id };
  }

  async updateBranch(
    tenantId: string,
    id: string,
    dto: {
      name?: string;
      type?: string;
      city?: string;
      region?: string;
      address?: string;
      phone?: string;
      status?: string;
    },
  ) {
    const branch = await this.prisma.branch.findFirst({ where: { tenantId, id } });
    if (!branch) throw new NotFoundException('Branch not found');
    await this.prisma.branch.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        type: (dto.type as never) ?? undefined,
        city: dto.city ?? undefined,
        region: dto.region ?? undefined,
        address: dto.address ?? undefined,
        phone: dto.phone ?? undefined,
        status:
          dto.status === 'inactive' ? 'inactive' : dto.status === 'active' ? 'active' : undefined,
      },
    });
    await this.audit(tenantId, 'branch.updated', 'branch', id);
    return { id };
  }

  async deleteBranch(tenantId: string, id: string) {
    const branch = await this.prisma.branch.findFirst({ where: { tenantId, id } });
    if (!branch) throw new NotFoundException('Branch not found');
    await this.prisma.branch.delete({ where: { id } });
    await this.audit(tenantId, 'branch.deleted', 'branch', id);
    return { id };
  }

  // --- helpers ------------------------------------------------------------
  private async resolveNames(customerIds: Array<string>, deviceIds: Array<string>) {
    const uIds = [...new Set(customerIds)];
    const dIds = [...new Set(deviceIds.filter(Boolean))];
    const [users, devices] = await Promise.all([
      uIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: uIds } },
            select: { id: true, fullName: true },
          })
        : Promise.resolve([]),
      dIds.length
        ? this.prisma.device.findMany({
            where: { id: { in: dIds } },
            select: { id: true, name: true, specs: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      userNames: new Map(users.map((u) => [u.id, u.fullName ?? 'Unknown'])),
      deviceNames: new Map(devices.map((d) => [d.id, d.name])),
      deviceImages: new Map(devices.map((d) => [d.id, this.imageUrl(d.specs)])),
    };
  }
}

// Business-role display map, aligned to the Electronics BNPL spec's admin roles
// (mirrors the portal's src/constants/roles.ts). The Prisma Role enum has no values
// for Support/Insurance yet, so no user record maps to them until the enum is
// expanded (P5 RBAC hardening) — the portal's "view as role" switcher still offers
// them. product_editor/country_manager both fold into Operations; agent → Agent.
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  country_manager: 'Country Manager',
  approvals_officer: 'Compliance',
  product_editor: 'Operations',
  agent: 'Agent',
  customer: 'Customer',
};

const DEPARTMENT_FOR: Record<string, string> = {
  'Super Admin': 'Executive',
  Admin: 'Administration',
  'Country Manager': 'Country Management',
  Operations: 'Operations & Finance',
  Compliance: 'Risk & Compliance',
  Agent: 'Retail',
  Customer: 'Customer',
};

const PERMISSIONS_FOR: Record<string, Array<string>> = {
  'Super Admin': ['Create', 'Read', 'Update', 'Delete'],
  Admin: ['Create', 'Read', 'Update', 'Delete'],
  'Country Manager': ['Create', 'Read', 'Update', 'Delete'],
  Operations: ['Create', 'Read', 'Update'],
  Compliance: ['Read', 'Update'],
  Agent: ['Create', 'Read'],
  Customer: ['Read'],
};

const TYPE_LABELS: Record<string, string> = {
  financing: 'Installments',
  lease: 'Lease',
  trade_in: 'Trade-in',
};

// Business role label -> underlying norex enum role (reverse of ROLE_LABELS).
function enumRole(business: string): Role {
  switch (business) {
    case 'Super Admin':
      return Role.super_admin;
    case 'Admin':
      return Role.admin;
    case 'Country Manager':
      return Role.country_manager;
    // Operations runs catalog, stock and outlets — the product_editor permission set.
    case 'Operations':
    case 'Product Editor':
      return Role.product_editor;
    case 'Compliance':
      return Role.approvals_officer;
    case 'Agent':
      return Role.agent;
    // Support/Insurance have no enum equivalent yet (P5) — fall through to customer.
    default:
      return Role.customer;
  }
}

function primaryRole(roles: Array<string>): string {
  const priority = [
    'super_admin',
    'admin',
    'country_manager',
    'approvals_officer',
    'product_editor',
    'agent',
    'customer',
  ];
  const top = priority.find((p) => roles.includes(p)) ?? roles[0] ?? 'customer';
  return ROLE_LABELS[top] ?? top;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Application lifecycle stages, with each marked done/current/upcoming based on
// the current status.
function buildTimeline(status: string, submittedAt: Date | null, decidedAt: Date | null) {
  const order = ['draft', 'submitted', 'under_review', 'approved', 'agreement_pending', 'active'];
  const rank: Record<string, number> = {
    draft: 0,
    submitted: 1,
    under_review: 2,
    info_requested: 2,
    approved: 3,
    agreement_pending: 4,
    active: 5,
    declined: 3,
    withdrawn: 1,
  };
  const current = rank[status] ?? 0;
  const stages: Array<{ key: string; label: string; rank: number; at: string | null }> = [
    { key: 'submitted', label: 'Submitted', rank: 1, at: submittedAt?.toISOString() ?? null },
    { key: 'under_review', label: 'Under Review', rank: 2, at: null },
    { key: 'approved', label: 'Approved', rank: 3, at: decidedAt?.toISOString() ?? null },
    { key: 'disbursed', label: 'Disbursed', rank: 4, at: null },
    { key: 'active', label: 'Active Repayment', rank: 5, at: null },
    { key: 'completed', label: 'Completed', rank: 6, at: null },
  ];
  void order;
  return stages.map((s) => ({
    key: s.key,
    label: s.label,
    at: s.at,
    state: s.rank < current ? 'done' : s.rank === current ? 'current' : 'upcoming',
  }));
}

// Super Admins live in the hq tenant, so RLS hides their user row from a country's
// log; name them by role rather than showing "System".
function actorLabel(
  actorId: string | null,
  actorRole: string | null,
  names: Map<string, string>,
): string {
  if (!actorId) return 'System';
  const name = names.get(actorId);
  if (name) return name;
  return actorRole?.includes('super_admin') ? 'Super Admin (HQ)' : 'Staff';
}

// Portfolio-at-risk ageing buckets used by Collections & Recovery.
function parBucket(days: number): '1-30' | '31-60' | '61-90' | '90+' {
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
