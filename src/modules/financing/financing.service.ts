import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FinanceEligibilityRule, FinanceFeeMode, FinancePlanTerm, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { computeFlatInstallment, computeInstallment, upfrontInRange } from './finance.calculator';
import { CreatePlanDto, UpdateRulesDto, UpdateTermDto } from './dto/finance.dto';

interface Actor {
  id: string;
  roles: string[];
}

type DevicePricing = NonNullable<Awaited<ReturnType<CatalogService['getDeviceForPricing']>>>;

export interface FinanceSnapshot {
  type: 'financing';
  months: number;
  depositMinor: number;
  monthlyMinor: number;
  finalMonthlyMinor: number;
  totalRepayableMinor: number;
  totalPayableMinor: number;
  currency: string;
  planTermId: string;
  computedAt: string;
}

@Injectable()
export class FinancingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  // The active plan for a tenant (most recently updated wins if several are active).
  private async activePlan(tenantId: string) {
    return this.prisma.financePlan.findFirst({
      where: { tenantId, isActive: true },
      include: {
        terms: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        rules: { where: { isActive: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private ruleAllows(device: DevicePricing, rules: FinanceEligibilityRule[]): boolean {
    if (rules.length === 0) return true; // no rules configured = allow
    return rules.some(
      (r) =>
        device.cashPriceMinor >= r.minPriceMinor &&
        (r.maxPriceMinor == null || device.cashPriceMinor <= r.maxPriceMinor) &&
        (r.categoryId == null || r.categoryId === device.categoryId) &&
        (!r.requireInStock || device.inStock),
    );
  }

  // One term priced for a device. `upfrontMinor` (20–80% of cash) replaces the plan
  // deposit on FLEX terms; the fee is unchanged, only the monthly moves.
  private option(device: DevicePricing, term: FinancePlanTerm, upfrontMinor?: number) {
    const planDeposit = Math.round((device.cashPriceMinor * term.depositPctBps) / 10000);
    const c =
      term.feeMode === FinanceFeeMode.flat_on_cash
        ? computeFlatInstallment({
            cashPriceMinor: device.cashPriceMinor,
            months: term.months,
            premiumBps: term.premiumBps,
            minPremiumMinor: term.minPremiumMinor,
            depositMinor: upfrontMinor ?? planDeposit,
          })
        : computeInstallment({
            cashPriceMinor: device.cashPriceMinor,
            depositPctBps: term.depositPctBps,
            months: term.months,
            monthlyMarkupBps: term.monthlyMarkupBps,
          });
    return {
      months: term.months,
      planTermId: term.id,
      depositMinor: c.depositMinor,
      monthlyMinor: c.monthlyMinor,
      finalMonthlyMinor: c.finalMonthlyMinor,
      totalRepayableMinor: c.totalRepayableMinor,
      totalPayableMinor: c.totalPayableMinor,
    };
  }

  // ---------- public ----------
  async options(tenantId: string, deviceId: string) {
    const device = await this.catalog.getDeviceForPricing(tenantId, deviceId);
    // Stock is a plan eligibility rule (requireInStock), not a hard gate: FLEX
    // plans quote and accept applications for out-of-stock devices.
    if (!device || !device.financeEligible) return { deviceId, currency: null, options: [] };
    const plan = await this.activePlan(tenantId);
    if (!plan || !this.ruleAllows(device, plan.rules))
      return { deviceId, currency: device.currency, options: [] };
    return {
      deviceId,
      currency: device.currency,
      options: plan.terms.map((t) => this.option(device, t)),
    };
  }

  // Cheapest monthly for many devices in one call (catalog cards: "from X/mo").
  async fromQuotes(tenantId: string, deviceIds: string[]) {
    const plan = await this.activePlan(tenantId);
    const out: Record<
      string,
      { months: number; monthlyMinor: number; depositMinor: number } | null
    > = {};
    await Promise.all(
      deviceIds.map(async (id) => {
        const device = await this.catalog.getDeviceForPricing(tenantId, id);
        if (!plan || !device || !device.financeEligible || !this.ruleAllows(device, plan.rules)) {
          out[id] = null;
          return;
        }
        const best = plan.terms
          .map((t) => this.option(device, t))
          .sort((a, b) => a.monthlyMinor - b.monthlyMinor)[0];
        out[id] = best
          ? {
              months: best.months,
              monthlyMinor: best.monthlyMinor,
              depositMinor: best.depositMinor,
            }
          : null;
      }),
    );
    return { from: out };
  }

  async quote(tenantId: string, deviceId: string, months: number, upfrontMinor?: number) {
    const { device, term } = await this.resolve(tenantId, deviceId, months);
    this.checkUpfront(device, term, upfrontMinor);
    return { deviceId, currency: device.currency, ...this.option(device, term, upfrontMinor) };
  }

  private checkUpfront(device: DevicePricing, term: FinancePlanTerm, upfrontMinor?: number) {
    if (upfrontMinor == null) return;
    if (term.feeMode !== FinanceFeeMode.flat_on_cash)
      throw new BadRequestException('A custom upfront amount is only available on FLEX plans');
    if (!upfrontInRange(device.cashPriceMinor, upfrontMinor))
      throw new BadRequestException('Upfront must be between 20% and 80% of the cash price');
  }

  // Immutable snapshot consumed by application submit (docs/07).
  async buildSnapshot(
    tenantId: string,
    deviceId: string,
    months: number,
    upfrontMinor?: number,
    variantId?: string | null,
  ): Promise<FinanceSnapshot> {
    const { device, term } = await this.resolve(tenantId, deviceId, months, variantId);
    this.checkUpfront(device, term, upfrontMinor);
    const o = this.option(device, term, upfrontMinor);
    return {
      type: 'financing',
      months: o.months,
      depositMinor: o.depositMinor,
      monthlyMinor: o.monthlyMinor,
      finalMonthlyMinor: o.finalMonthlyMinor,
      totalRepayableMinor: o.totalRepayableMinor,
      totalPayableMinor: o.totalPayableMinor,
      currency: device.currency,
      planTermId: term.id,
      computedAt: new Date().toISOString(),
    };
  }

  private async resolve(
    tenantId: string,
    deviceId: string,
    months: number,
    variantId?: string | null,
  ): Promise<{ device: DevicePricing; term: FinancePlanTerm }> {
    const device = await this.catalog.getDeviceForPricing(tenantId, deviceId, variantId);
    if (!device || !device.financeEligible) {
      throw new BadRequestException('Device is not available for financing');
    }
    const plan = await this.activePlan(tenantId);
    if (!plan) throw new BadRequestException('No active financing plan');
    if (!this.ruleAllows(device, plan.rules))
      throw new BadRequestException('Device is not eligible for financing');
    const term = plan.terms.find((t) => t.months === months);
    if (!term) throw new BadRequestException(`No ${months}-month term available`);
    return { device, term };
  }

  // ---------- admin (country_manager writes) ----------
  listPlans(tenantId: string) {
    return this.prisma.financePlan.findMany({
      where: { tenantId },
      include: { terms: { orderBy: { sortOrder: 'asc' } }, rules: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createPlan(actor: Actor, tenantId: string, dto: CreatePlanDto) {
    const plan = await this.prisma.financePlan.create({
      data: {
        tenantId,
        name: dto.name,
        createdById: actor.id,
        updatedById: actor.id,
        terms: {
          create: dto.terms.map((t) => ({
            tenantId,
            months: t.months,
            depositPctBps: t.depositPctBps,
            monthlyMarkupBps: t.monthlyMarkupBps,
            feeMode: t.feeMode ?? FinanceFeeMode.monthly_markup,
            premiumBps: t.premiumBps ?? 0,
            minPremiumMinor: t.minPremiumMinor ?? 0,
            sortOrder: t.sortOrder ?? 0,
          })),
        },
        rules: {
          create: (dto.rules ?? []).map((r) => ({
            tenantId,
            minPriceMinor: r.minPriceMinor ?? 0,
            maxPriceMinor: r.maxPriceMinor,
            categoryId: r.categoryId,
            requireInStock: r.requireInStock ?? false,
          })),
        },
      },
      include: { terms: true, rules: true },
    });
    await this.audit.write(
      tenantId,
      this.auditEvent(actor, 'finance.plan.created', plan.id, undefined, { name: dto.name }),
    );
    return plan;
  }

  async updateTerm(
    actor: Actor,
    tenantId: string,
    planId: string,
    termId: string,
    dto: UpdateTermDto,
  ) {
    const before = await this.prisma.financePlanTerm.findFirst({
      where: { id: termId, tenantId, planId },
    });
    if (!before) throw new NotFoundException('Term not found');

    const changes: Array<{ field: string; oldValue: string; newValue: string }> = [];
    const track = (field: keyof UpdateTermDto, oldV: number | boolean) => {
      const next = dto[field];
      if (next !== undefined && next !== oldV)
        changes.push({ field, oldValue: String(oldV), newValue: String(next) });
    };
    track('depositPctBps', before.depositPctBps);
    track('monthlyMarkupBps', before.monthlyMarkupBps);
    track('premiumBps', before.premiumBps);
    track('minPremiumMinor', before.minPremiumMinor);
    track('months', before.months);
    track('isActive', before.isActive);

    const [term] = await this.prisma.$transaction([
      this.prisma.financePlanTerm.update({
        where: { id: termId },
        data: {
          depositPctBps: dto.depositPctBps,
          monthlyMarkupBps: dto.monthlyMarkupBps,
          premiumBps: dto.premiumBps,
          minPremiumMinor: dto.minPremiumMinor,
          months: dto.months,
          isActive: dto.isActive,
        },
      }),
      ...changes.map((c) =>
        this.prisma.financeRateHistory.create({
          data: {
            tenantId,
            planTermId: termId,
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
            actorId: actor.id,
            actorRole: actor.roles.join(','),
          },
        }),
      ),
    ]);
    await this.audit.write(
      tenantId,
      this.auditEvent(
        actor,
        'finance.term.updated',
        termId,
        { changes: changes.map((c) => c.field) },
        { ...dto },
      ),
    );
    return term;
  }

  async updateRules(actor: Actor, tenantId: string, planId: string, dto: UpdateRulesDto) {
    const plan = await this.prisma.financePlan.findFirst({ where: { id: planId, tenantId } });
    if (!plan) throw new NotFoundException('Plan not found');
    await this.prisma.$transaction([
      this.prisma.financeEligibilityRule.deleteMany({ where: { tenantId, planId } }),
      this.prisma.financeEligibilityRule.createMany({
        data: dto.rules.map((r) => ({
          tenantId,
          planId,
          minPriceMinor: r.minPriceMinor ?? 0,
          maxPriceMinor: r.maxPriceMinor,
          categoryId: r.categoryId,
          requireInStock: r.requireInStock ?? false,
        })),
      }),
    ]);
    await this.audit.write(
      tenantId,
      this.auditEvent(actor, 'finance.rules.updated', planId, undefined, {
        count: dto.rules.length,
      }),
    );
    return this.prisma.financeEligibilityRule.findMany({ where: { tenantId, planId } });
  }

  async activate(actor: Actor, tenantId: string, planId: string) {
    const plan = await this.prisma.financePlan.findFirst({ where: { id: planId, tenantId } });
    if (!plan) throw new NotFoundException('Plan not found');
    // One active plan per country, so a quote is never ambiguous (same as lease).
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.financePlan.updateMany({
        where: { tenantId, isActive: true, id: { not: planId } },
        data: { isActive: false },
      });
      return tx.financePlan.update({
        where: { id: planId },
        data: { isActive: true, updatedById: actor.id },
      });
    });
    await this.audit.write(
      tenantId,
      this.auditEvent(
        actor,
        'finance.plan.activated',
        planId,
        { isActive: plan.isActive },
        { isActive: true },
      ),
    );
    return updated;
  }

  private auditEvent(
    actor: Actor,
    action: string,
    entityId: string,
    before?: Prisma.InputJsonValue,
    after?: Prisma.InputJsonValue,
  ) {
    return {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action,
      entity: 'finance',
      entityId,
      before,
      after,
    };
  }
}
