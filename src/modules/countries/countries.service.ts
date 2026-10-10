import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, Tenant } from '@prisma/client';
import { AuditService, AuditEvent } from '../../common/audit/audit.service';
import { asSystem, withTenant } from '../../common/context/request-context';
import { StaffInviteService } from '../auth/staff-invite.service';
import { TenantMiddleware } from '../../common/middleware/tenant.middleware';
import { normalizeHost } from '../../common/tenancy/resolve-tenant';
import { PrismaService } from '../../database/prisma.service';
import { convertMinor, minorRatePpm } from './clone.math';
import { provisionCountryDefaults } from './country-defaults';
import {
  AddDomainDto,
  CloneCatalogDto,
  CreateCountryDto,
  CreateCountryManagerDto,
  UpdateCountryDto,
} from './dto/countries.dto';

export interface Actor {
  id: string;
  tenantId: string;
  roles: string[];
}

const HQ = 'hq';
// Words the tenant resolver or routing already uses; never a country slug.
const RESERVED_SLUGS = new Set(['hq', 'all', 'www', 'api', 'admin', 'app', 'localhost']);
const DEFAULT_ID_REGEX = '^[A-Z0-9]{6,20}$';

function currencyDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits as number;
}

// Countries = tenants (docs/15). Super Admin runs set-up (domains, managers, the
// one-time catalog clone); a Country Manager only sees their own country.
@Injectable()
export class CountriesService {
  private readonly log = new Logger(CountriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invites: StaffInviteService,
  ) {}

  async list(actor: Actor) {
    const superAdmin = actor.roles.includes(Role.super_admin);
    const tenants = await this.prisma.tenant.findMany({
      where: superAdmin ? { isCountry: true } : { id: actor.tenantId },
      orderBy: { name: 'asc' },
      include: { domains: { orderBy: { host: 'asc' } } },
    });
    return Promise.all(
      tenants.map(async (t) => ({
        ...this.view(t),
        kpis: await withTenant(t.id, () => this.kpis(t.id)),
      })),
    );
  }

  // Super Admin "Add country": the tenant plus the same defaults the original four
  // got (country-defaults.ts). Starts unlaunched unless asked: staff can prepare it
  // (catalog, managers) while the public website can't see it yet.
  async create(actor: Actor, dto: CreateCountryDto) {
    const slug = dto.slug.toLowerCase();
    if (RESERVED_SLUGS.has(slug)) throw new BadRequestException(`"${slug}" is reserved`);
    if (await this.prisma.tenant.findUnique({ where: { subdomain: slug } })) {
      throw new ConflictException(`A country with the slug "${slug}" already exists`);
    }
    const iso = dto.country.toUpperCase();
    if (await this.prisma.tenant.findFirst({ where: { country: iso, isCountry: true } })) {
      throw new ConflictException(`${iso} is already set up as a country`);
    }
    if (!Intl.supportedValuesOf('timeZone').includes(dto.timezone)) {
      throw new BadRequestException(`Unknown timezone "${dto.timezone}"`);
    }
    const idNumberRegex = dto.idNumberRegex?.trim() || DEFAULT_ID_REGEX;
    try {
      new RegExp(idNumberRegex);
    } catch {
      throw new BadRequestException('The ID number pattern is not a valid regular expression');
    }
    const currency = dto.currency.toUpperCase();
    const minorUnitDigits = currencyDigits(currency);

    const tenant = await this.prisma.tenant.create({
      data: {
        subdomain: slug,
        name: dto.name.trim(),
        country: iso,
        currency,
        minorUnitDigits,
        dialCode: dto.dialCode,
        timezone: dto.timezone,
        locale: dto.locale?.trim() || `en-${iso}`,
        idType: dto.idType.trim(),
        isCountry: true,
        active: !!dto.active,
        launchedAt: dto.active ? new Date() : null,
        startingFxPpm: dto.startingFxPpm,
        startingRoundStepMinor: dto.startingRoundStepMinor,
      },
    });
    // RLS: the new country's rows are written inside its own scope.
    await withTenant(tenant.id, () =>
      provisionCountryDefaults(this.prisma, {
        tenantId: tenant.id,
        minorUnitDigits,
        idType: tenant.idType,
        idTypeCode: `${iso.toLowerCase()}_national_id`,
        idNumberRegex,
        startingFxPpm: dto.startingFxPpm,
        startingRoundStepMinor: dto.startingRoundStepMinor,
      }),
    );
    await this.auditBoth(tenant.id, actor, {
      action: 'country.created',
      entity: 'tenant',
      entityId: tenant.id,
      after: { slug, country: iso, currency, active: !!dto.active },
    });
    TenantMiddleware.invalidate();
    return {
      ...this.view({ ...tenant, domains: [] }),
      kpis: await withTenant(tenant.id, () => this.kpis(tenant.id)),
    };
  }

  /** Public list for the portal's sign-in page (no auth; names only). */
  async publicList() {
    const tenants = await this.prisma.tenant.findMany({
      where: { isCountry: true },
      orderBy: { name: 'asc' },
      select: { subdomain: true, name: true, country: true, currency: true, active: true },
    });
    return tenants.map((t) => ({
      slug: t.subdomain,
      name: t.name,
      country: t.country,
      currency: t.currency,
      active: t.active,
    }));
  }

  async update(actor: Actor, slug: string, dto: UpdateCountryDto) {
    const tenant = await this.bySlug(slug);
    if (
      dto.currency &&
      dto.currency !== tenant.currency &&
      (await withTenant(tenant.id, () => this.hasPricedRows(tenant.id)))
    ) {
      throw new BadRequestException('Currency is locked once the country has prices or payments');
    }
    const updated = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        active: dto.active,
        name: dto.name,
        timezone: dto.timezone,
        locale: dto.locale,
        dialCode: dto.dialCode,
        idType: dto.idType,
        currency: dto.currency,
        deliveryFeeMinor: dto.deliveryFeeMinor,
        agentCommissionBps: dto.agentCommissionBps,
        partnerOutletFeeBps: dto.partnerOutletFeeBps,
        launchedAt: dto.active && !tenant.launchedAt ? new Date() : undefined,
      },
      include: { domains: true },
    });
    await this.auditBoth(tenant.id, actor, {
      action: 'country.updated',
      entity: 'tenant',
      entityId: tenant.id,
      before: pick(tenant, Object.keys(dto)),
      after: dto as Prisma.InputJsonValue,
    });
    TenantMiddleware.invalidate();
    PrismaService.invalidateCurrencies();
    return this.view(updated);
  }

  async addDomain(actor: Actor, slug: string, dto: AddDomainDto) {
    const tenant = await this.bySlug(slug);
    const host = normalizeHost(dto.host);
    if (await this.prisma.tenantDomain.findUnique({ where: { host } })) {
      throw new ConflictException('That domain is already mapped');
    }
    const domain = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.tenantDomain.updateMany({
          where: { tenantId: tenant.id },
          data: { isPrimary: false },
        });
      }
      return tx.tenantDomain.create({
        data: { tenantId: tenant.id, host, isPrimary: !!dto.isPrimary },
      });
    });
    await this.auditBoth(tenant.id, actor, {
      action: 'country.domain_added',
      entity: 'tenant_domain',
      entityId: domain.id,
      after: { host },
    });
    TenantMiddleware.invalidate();
    return domain;
  }

  async removeDomain(actor: Actor, slug: string, id: string) {
    const tenant = await this.bySlug(slug);
    const domain = await this.prisma.tenantDomain.findFirst({ where: { id, tenantId: tenant.id } });
    if (!domain) throw new NotFoundException('Domain not found');
    await this.prisma.tenantDomain.delete({ where: { id } });
    await this.auditBoth(tenant.id, actor, {
      action: 'country.domain_removed',
      entity: 'tenant_domain',
      entityId: id,
      before: { host: domain.host },
    });
    TenantMiddleware.invalidate();
    return { id };
  }

  async managers(slug: string) {
    // RLS: the country's users are only visible inside its scope.
    return this.inCountry(slug, async (tenant) => {
      const users = await this.prisma.user.findMany({
        where: { tenantId: tenant.id, roles: { some: { role: Role.country_manager } } },
        orderBy: { createdAt: 'asc' },
      });
      return users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        phone: u.phone,
        status: u.status,
        totpEnrolled: !!u.totpEnabledAt,
        createdAt: u.createdAt.toISOString(),
      }));
    });
  }

  // Invite = a staff account plus a single-use link (emailed when mail is set up) to
  // choose a password and set up two-factor (docs/20).
  async createManager(actor: Actor, slug: string, dto: CreateCountryManagerDto) {
    // RLS: the country's users are only visible inside its scope.
    return this.inCountry(slug, async (tenant) => {
      const email = dto.email.toLowerCase();
      if (await this.prisma.user.findFirst({ where: { tenantId: tenant.id, email } })) {
        throw new ConflictException('A user with that email already exists in this country');
      }
      if (
        dto.phone &&
        tenant.dialCode &&
        dto.phone.startsWith('+') &&
        !dto.phone.startsWith(tenant.dialCode)
      ) {
        throw new BadRequestException(`Phone must use the ${tenant.dialCode} dial code`);
      }
      const user = await this.prisma.user.create({
        data: {
          tenantId: tenant.id,
          email,
          phone: dto.phone ?? null,
          fullName: dto.fullName,
          isStaff: true,
          roles: { create: [{ tenantId: tenant.id, role: Role.country_manager }] },
        },
      });
      await this.auditBoth(tenant.id, actor, {
        action: 'country.manager_created',
        entity: 'user',
        entityId: user.id,
        after: { email, country: tenant.subdomain },
      });
      const invite = await this.invites.invite(
        tenant.id,
        { id: user.id, email, fullName: dto.fullName },
        { invitedBy: null, reason: 'new' },
      );
      return { id: user.id, email, country: tenant.subdomain, invite };
    });
  }

  async setManagerStatus(
    actor: Actor,
    slug: string,
    userId: string,
    status: 'active' | 'suspended',
  ) {
    // RLS: the country's users are only visible inside its scope.
    return this.inCountry(slug, async (tenant) => {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, tenantId: tenant.id, roles: { some: { role: Role.country_manager } } },
      });
      if (!user) throw new NotFoundException('Country Manager not found');
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: { status } }),
        ...(status === 'suspended'
          ? [
              this.prisma.session.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: new Date() },
              }),
            ]
          : []),
      ]);
      await this.auditBoth(tenant.id, actor, {
        action:
          status === 'suspended' ? 'country.manager_suspended' : 'country.manager_reactivated',
        entity: 'user',
        entityId: userId,
        before: { status: user.status },
        after: { status },
      });
      return { id: userId, status };
    });
  }

  async startClone(actor: Actor, slug: string, dto: CloneCatalogDto) {
    const target = await this.bySlug(slug);
    const source = await this.bySlug(dto.sourceTenant);
    if (source.id === target.id) throw new BadRequestException('Source and target must differ');
    const busy = await this.prisma.catalogCloneJob.findFirst({
      where: { targetTenantId: target.id, status: { in: ['queued', 'running'] } },
    });
    if (busy) throw new ConflictException('A clone is already running for this country');

    const job = await this.prisma.catalogCloneJob.create({
      data: {
        sourceTenantId: source.id,
        targetTenantId: target.id,
        fxRatePpm: dto.fxRatePpm,
        roundingStepMinor: dto.roundingStepMinor,
        includeRates: dto.includeRates ?? true,
        createdById: actor.id,
      },
    });
    await this.auditBoth(target.id, actor, {
      action: 'country.catalog_clone_started',
      entity: 'catalog_clone_job',
      entityId: job.id,
      after: {
        from: source.subdomain,
        fxRatePpm: dto.fxRatePpm,
        roundingStepMinor: dto.roundingStepMinor,
      },
    });
    // No queue in this service yet: run in-process and report progress via the job row.
    void asSystem(() => this.runClone(job.id, source, target)).catch((e) => this.log.error(e));
    return this.jobView(job);
  }

  async cloneStatus(slug: string, jobId: string) {
    const target = await this.bySlug(slug);
    const job = await this.prisma.catalogCloneJob.findFirst({
      where: { id: jobId, targetTenantId: target.id },
    });
    if (!job) throw new NotFoundException('Clone job not found');
    return this.jobView(job);
  }

  /** Exposed for tests; normally triggered by startClone. */
  async runClone(jobId: string, source: Tenant, target: Tenant) {
    const job = await this.prisma.catalogCloneJob.update({
      where: { id: jobId },
      data: { status: 'running' },
    });
    const rate = minorRatePpm(job.fxRatePpm, source.minorUnitDigits, target.minorUnitDigits);
    const conv = (minor: number) => convertMinor(minor, rate, job.roundingStepMinor);
    try {
      const created = await this.prisma.$transaction(
        (tx) => this.cloneInto(tx, source, target, conv, job.includeRates),
        { timeout: 120_000 },
      );
      await this.prisma.catalogCloneJob.update({
        where: { id: jobId },
        data: { status: 'done', devicesCreated: created, finishedAt: new Date() },
      });
    } catch (e) {
      await this.prisma.catalogCloneJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          error: String((e as Error).message ?? e).slice(0, 500),
          finishedAt: new Date(),
        },
      });
    }
  }

  // Devices arrive as drafts with zero stock; slugs that already exist are skipped so
  // a re-run never overwrites the country's own edits.
  private async cloneInto(
    tx: Prisma.TransactionClient,
    source: Tenant,
    target: Tenant,
    conv: (minor: number) => number,
    includeRates: boolean,
  ): Promise<number> {
    const brandMap = new Map<string, string>();
    for (const b of await tx.brand.findMany({ where: { tenantId: source.id } })) {
      const t = await tx.brand.upsert({
        where: { tenantId_slug: { tenantId: target.id, slug: b.slug } },
        create: { tenantId: target.id, name: b.name, slug: b.slug, isActive: b.isActive },
        update: {},
      });
      brandMap.set(b.id, t.id);
    }
    const categoryMap = new Map<string, string>();
    const categories = await tx.category.findMany({
      where: { tenantId: source.id },
      orderBy: { parentId: 'asc' },
    });
    for (const c of categories) {
      const t = await tx.category.upsert({
        where: { tenantId_slug: { tenantId: target.id, slug: c.slug } },
        create: {
          tenantId: target.id,
          name: c.name,
          slug: c.slug,
          sortOrder: c.sortOrder,
          isActive: c.isActive,
        },
        update: {},
      });
      categoryMap.set(c.id, t.id);
    }
    for (const c of categories) {
      if (c.parentId && categoryMap.has(c.parentId)) {
        await tx.category.update({
          where: { id: categoryMap.get(c.id)! },
          data: { parentId: categoryMap.get(c.parentId) },
        });
      }
    }

    const existing = new Set(
      (await tx.device.findMany({ where: { tenantId: target.id }, select: { slug: true } })).map(
        (d) => d.slug,
      ),
    );
    const devices = await tx.device.findMany({
      where: { tenantId: source.id, status: { not: 'archived' } },
      include: { variants: true, media: true },
    });
    let created = 0;
    for (const d of devices) {
      if (existing.has(d.slug)) continue;
      await tx.device.create({
        data: {
          tenantId: target.id,
          brandId: brandMap.get(d.brandId)!,
          categoryId: categoryMap.get(d.categoryId)!,
          name: d.name,
          slug: d.slug,
          summary: d.summary,
          status: 'draft',
          cashPriceMinor: conv(d.cashPriceMinor),
          currency: target.currency,
          financeEligible: d.financeEligible,
          leaseEligible: d.leaseEligible,
          tradeInEligible: d.tradeInEligible,
          featured: d.featured,
          specs: d.specs ?? undefined,
          variants: {
            create: d.variants.map((v) => ({
              tenantId: target.id,
              sku: v.sku,
              storage: v.storage,
              color: v.color,
              priceDeltaMinor: v.priceDeltaMinor === 0 ? 0 : conv(v.priceDeltaMinor),
              stockQty: 0,
              isActive: v.isActive,
            })),
          },
          // Media rows point at the same stored objects; nothing is copied in storage.
          media: {
            create: d.media.map((m) => ({
              tenantId: target.id,
              s3Key: m.s3Key,
              kind: m.kind,
              altText: m.altText,
              sortOrder: m.sortOrder,
              isPrimary: m.isPrimary,
              width: m.width,
              height: m.height,
              bytes: m.bytes,
            })),
          },
        },
      });
      created++;
    }

    if (includeRates) await this.cloneRates(tx, source, target, conv, categoryMap);
    return created;
  }

  // Percentages copy unchanged; absolute amounts (FLEX minimum fees, price bands,
  // fixed lease fees) convert. Plans arrive inactive for the manager to review.
  private async cloneRates(
    tx: Prisma.TransactionClient,
    source: Tenant,
    target: Tenant,
    conv: (minor: number) => number,
    categoryMap: Map<string, string>,
  ) {
    const cat = (id: string | null) => (id ? (categoryMap.get(id) ?? null) : null);
    const optConv = (v: number | null) => (v == null ? null : conv(v));

    const plans = await tx.financePlan.findMany({
      where: { tenantId: source.id, isActive: true },
      include: { terms: true, rules: true },
    });
    // Re-runs never duplicate: a plan/config the country already has by name is kept.
    const havePlans = new Set(
      (
        await tx.financePlan.findMany({ where: { tenantId: target.id }, select: { name: true } })
      ).map((p) => p.name),
    );
    for (const p of plans) {
      if (havePlans.has(p.name)) continue;
      await tx.financePlan.create({
        data: {
          tenantId: target.id,
          name: p.name,
          isActive: false,
          terms: {
            create: p.terms.map((t) => ({
              tenantId: target.id,
              months: t.months,
              depositPctBps: t.depositPctBps,
              monthlyMarkupBps: t.monthlyMarkupBps,
              feeMode: t.feeMode,
              premiumBps: t.premiumBps,
              minPremiumMinor: conv(t.minPremiumMinor),
              isActive: t.isActive,
              sortOrder: t.sortOrder,
            })),
          },
          rules: {
            create: p.rules.map((r) => ({
              tenantId: target.id,
              minPriceMinor: conv(r.minPriceMinor),
              maxPriceMinor: optConv(r.maxPriceMinor),
              categoryId: cat(r.categoryId),
              requireInStock: r.requireInStock,
              isActive: r.isActive,
            })),
          },
        },
      });
    }

    const leases = await tx.leaseRateConfig.findMany({
      where: { tenantId: source.id, isActive: true },
      include: { terms: true },
    });
    const haveLeases = new Set(
      (
        await tx.leaseRateConfig.findMany({
          where: { tenantId: target.id },
          select: { name: true },
        })
      ).map((l) => l.name),
    );
    for (const l of leases) {
      if (haveLeases.has(l.name)) continue;
      await tx.leaseRateConfig.create({
        data: {
          tenantId: target.id,
          name: l.name,
          isActive: false,
          terms: {
            create: l.terms.map((t) => ({
              tenantId: target.id,
              months: t.months,
              monthlyFeeBps: t.monthlyFeeBps,
              monthlyFeeMinor: optConv(t.monthlyFeeMinor),
              categoryId: cat(t.categoryId),
              minPriceMinor: conv(t.minPriceMinor),
              maxPriceMinor: optConv(t.maxPriceMinor),
              isActive: t.isActive,
              sortOrder: t.sortOrder,
            })),
          },
        },
      });
    }
  }

  private async kpis(tenantId: string) {
    const [stock, published, openApplications, collected, devices, managers] = await Promise.all([
      this.prisma.deviceVariant.aggregate({
        where: { tenantId, isActive: true },
        _sum: { stockQty: true },
      }),
      this.prisma.device.count({ where: { tenantId, status: 'published' } }),
      this.prisma.application.count({
        where: { tenantId, status: { in: ['submitted', 'under_review', 'info_requested'] } },
      }),
      this.prisma.payment.aggregate({
        where: { tenantId, status: 'succeeded' },
        _sum: { amountMinor: true },
      }),
      this.prisma.device.count({ where: { tenantId, status: { not: 'archived' } } }),
      this.prisma.user.count({
        where: { tenantId, roles: { some: { role: Role.country_manager } } },
      }),
    ]);
    return {
      stockUnits: stock._sum.stockQty ?? 0,
      devices,
      managers,
      publishedDevices: published,
      openApplications,
      collectedMinor: collected._sum.amountMinor ?? 0,
    };
  }

  private async hasPricedRows(tenantId: string) {
    // Same rule as the DB trigger in prisma/currency-guard.sql.
    const [devices, payments, applications] = await Promise.all([
      this.prisma.device.count({ where: { tenantId } }),
      this.prisma.payment.count({ where: { tenantId } }),
      this.prisma.application.count({ where: { tenantId } }),
    ]);
    return devices + payments + applications > 0;
  }

  private async inCountry<T>(slug: string, fn: (tenant: Tenant) => Promise<T>): Promise<T> {
    const tenant = await this.bySlug(slug);
    return withTenant(tenant.id, () => fn(tenant));
  }

  private async bySlug(slug: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { subdomain: slug } });
    if (!tenant || !tenant.isCountry) throw new NotFoundException(`Unknown country "${slug}"`);
    return tenant;
  }

  // Country set-up is recorded on the country itself and on hq (docs/15 Audit).
  private async auditBoth(
    tenantId: string,
    actor: Actor,
    event: Omit<AuditEvent, 'actorId' | 'actorRole'>,
  ) {
    const full = { ...event, actorId: actor.id, actorRole: actor.roles.join(',') };
    await this.audit.write(tenantId, full);
    const hq = await this.prisma.tenant.findUnique({
      where: { subdomain: HQ },
      select: { id: true },
    });
    if (hq && hq.id !== tenantId) await this.audit.write(hq.id, full);
  }

  private view(t: Tenant & { domains?: { id: string; host: string; isPrimary: boolean }[] }) {
    return {
      id: t.id,
      slug: t.subdomain,
      name: t.name,
      country: t.country,
      currency: t.currency,
      minorUnitDigits: t.minorUnitDigits,
      dialCode: t.dialCode,
      timezone: t.timezone,
      locale: t.locale,
      idType: t.idType,
      active: t.active,
      launchedAt: t.launchedAt?.toISOString() ?? null,
      startingFxPpm: t.startingFxPpm,
      startingRoundStepMinor: t.startingRoundStepMinor,
      deliveryFeeMinor: t.deliveryFeeMinor,
      agentCommissionBps: t.agentCommissionBps,
      partnerOutletFeeBps: t.partnerOutletFeeBps,
      domains: (t.domains ?? []).map((d) => ({ id: d.id, host: d.host, isPrimary: d.isPrimary })),
    };
  }

  private jobView(j: {
    id: string;
    status: string;
    devicesCreated: number;
    error: string | null;
    fxRatePpm: number;
    roundingStepMinor: number;
    includeRates: boolean;
    createdAt: Date;
    finishedAt: Date | null;
  }) {
    return {
      id: j.id,
      status: j.status,
      devicesCreated: j.devicesCreated,
      error: j.error,
      fxRatePpm: j.fxRatePpm,
      roundingStepMinor: j.roundingStepMinor,
      includeRates: j.includeRates,
      createdAt: j.createdAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
    };
  }
}

function pick(obj: object, keys: string[]): Prisma.InputJsonValue {
  const src = obj as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, (src[k] ?? null) as Prisma.InputJsonValue]));
}
