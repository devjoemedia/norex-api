import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Application, Lease, LeaseRateTerm, LeaseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { addMonths } from '../payments/schedule.builder';
import { computeMonthlyFee, isLeaseTerm } from './lease.calculator';
import { canLeaseTransition, LEASE_REFERENCE_PREFIX } from './lease.constants';
import {
  CreateLeaseConfigDto,
  LeaseReturnDto,
  LeaseUpgradeDto,
  TermsTemplateDto,
  UpdateLeaseTermDto,
} from './dto/lease.dto';

interface Actor {
  id: string;
  roles: string[];
}

type DevicePricing = NonNullable<Awaited<ReturnType<CatalogService['getDeviceForPricing']>>>;

const STAFF_ROLES = [
  'agent',
  'approvals_officer',
  'country_manager',
  'product_editor',
  'super_admin',
  'admin',
];
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface LeaseSnapshot {
  type: 'lease';
  months: number;
  monthlyFeeMinor: number;
  // Duplicated under the schedule-generator's field names so payments (docs/09) can
  // build a lease-fee schedule from this snapshot with no lease-specific code.
  monthlyMinor: number;
  finalMonthlyMinor: number;
  currency: string;
  rateTermId: string;
  termsVersion: number;
  computedAt: string;
}

@Injectable()
export class LeaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  private isStaff(roles: string[]): boolean {
    return roles.some((r) => STAFF_ROLES.includes(r));
  }

  private reference(): string {
    let code = '';
    for (let i = 0; i < 6; i++) code += REF_ALPHABET[randomInt(0, REF_ALPHABET.length)];
    return `${LEASE_REFERENCE_PREFIX}-${code}`;
  }

  private activeConfig(tenantId: string) {
    return this.prisma.leaseRateConfig.findFirst({
      where: { tenantId, isActive: true },
      include: { terms: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private termAllows(device: DevicePricing, term: LeaseRateTerm): boolean {
    return (
      device.cashPriceMinor >= term.minPriceMinor &&
      (term.maxPriceMinor == null || device.cashPriceMinor <= term.maxPriceMinor) &&
      (term.categoryId == null || term.categoryId === device.categoryId)
    );
  }

  private option(device: DevicePricing, term: LeaseRateTerm) {
    return {
      months: term.months,
      rateTermId: term.id,
      monthlyFeeMinor: computeMonthlyFee({
        cashPriceMinor: device.cashPriceMinor,
        monthlyFeeBps: term.monthlyFeeBps,
        monthlyFeeMinor: term.monthlyFeeMinor,
      }),
    };
  }

  // ---------- public ----------
  async options(tenantId: string, deviceId: string) {
    const device = await this.catalog.getDeviceForPricing(tenantId, deviceId);
    if (!device || !device.leaseEligible || !device.inStock)
      return { deviceId, currency: null, options: [] };
    const config = await this.activeConfig(tenantId);
    if (!config) return { deviceId, currency: device.currency, options: [] };
    return {
      deviceId,
      currency: device.currency,
      options: config.terms
        .filter((t) => this.termAllows(device, t))
        .map((t) => this.option(device, t)),
    };
  }

  async quote(tenantId: string, deviceId: string, months: number) {
    const { device, term } = await this.resolve(tenantId, deviceId, months);
    return { deviceId, currency: device.currency, ...this.option(device, term) };
  }

  activeTermsTemplate(tenantId: string) {
    return this.prisma.leaseTermsTemplate.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { version: 'desc' },
    });
  }

  // Immutable snapshot consumed by application submit (docs/07) and, at activation,
  // by the payments schedule generator (docs/09).
  async buildSnapshot(
    tenantId: string,
    deviceId: string,
    months: number,
    variantId?: string | null,
  ): Promise<LeaseSnapshot> {
    const { device, term } = await this.resolve(tenantId, deviceId, months, variantId);
    const o = this.option(device, term);
    const template = await this.activeTermsTemplate(tenantId);
    if (!template) throw new BadRequestException('No active lease terms template');
    return {
      type: 'lease',
      months: o.months,
      monthlyFeeMinor: o.monthlyFeeMinor,
      monthlyMinor: o.monthlyFeeMinor,
      finalMonthlyMinor: o.monthlyFeeMinor,
      currency: device.currency,
      rateTermId: term.id,
      termsVersion: template.version,
      computedAt: new Date().toISOString(),
    };
  }

  private async resolve(
    tenantId: string,
    deviceId: string,
    months: number,
    variantId?: string | null,
  ): Promise<{ device: DevicePricing; term: LeaseRateTerm }> {
    if (!isLeaseTerm(months)) throw new BadRequestException('Lease term must be 6 or 12 months');
    const device = await this.catalog.getDeviceForPricing(tenantId, deviceId, variantId);
    if (!device || !device.leaseEligible || !device.inStock) {
      throw new BadRequestException('Device is not available for lease');
    }
    const config = await this.activeConfig(tenantId);
    if (!config) throw new BadRequestException('No active lease rate config');
    const term = config.terms.find((t) => t.months === months && this.termAllows(device, t));
    if (!term) throw new BadRequestException(`No ${months}-month lease term available`);
    return { device, term };
  }

  // ---------- lease creation (called by applications on activation) ----------
  async createFromApplication(tenantId: string, actor: Actor, app: Application): Promise<Lease> {
    const existing = await this.prisma.lease.findFirst({
      where: { tenantId, applicationId: app.id },
    });
    if (existing) return existing; // idempotent

    const snap = app.planSnapshot as unknown as LeaseSnapshot | null;
    if (!snap || snap.type !== 'lease') {
      throw new BadRequestException('Application has no lease snapshot');
    }
    const startAt = new Date();
    const endAt = addMonths(startAt, snap.months);

    return this.prisma.$transaction(async (tx) => {
      const lease = await tx.lease.create({
        data: {
          tenantId,
          reference: this.reference(),
          customerId: app.customerId,
          applicationId: app.id,
          deviceId: app.deviceId,
          months: snap.months,
          monthlyFeeMinor: snap.monthlyFeeMinor,
          currency: snap.currency,
          termsVersion: snap.termsVersion,
          status: LeaseStatus.active,
          startAt,
          endAt,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'lease.created',
          entity: 'lease',
          entityId: lease.id,
          after: {
            applicationId: app.id,
            months: snap.months,
            monthlyFeeMinor: snap.monthlyFeeMinor,
          },
        },
      });
      return lease;
    });
  }

  // ---------- reads ----------
  private async load(tenantId: string, id: string): Promise<Lease> {
    const lease = await this.prisma.lease.findFirst({ where: { id, tenantId } });
    if (!lease) throw new NotFoundException('Lease not found');
    return lease;
  }

  list(tenantId: string, user: Actor, status?: string) {
    return this.prisma.lease.findMany({
      where: {
        tenantId,
        ...(this.isStaff(user.roles) ? {} : { customerId: user.id }),
        ...(status ? { status: status as LeaseStatus } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOne(tenantId: string, user: Actor, id: string) {
    const lease = await this.prisma.lease.findFirst({
      where: { id, tenantId },
      include: { events: { orderBy: { createdAt: 'asc' } }, returns: true },
    });
    if (!lease) throw new NotFoundException('Lease not found');
    if (!this.isStaff(user.roles) && lease.customerId !== user.id) {
      throw new ForbiddenException('Not your lease');
    }
    return lease;
  }

  // ---------- lifecycle (staff) ----------
  async returnLease(actor: Actor, tenantId: string, id: string, dto: LeaseReturnDto) {
    const lease = await this.load(tenantId, id);
    if (!canLeaseTransition(lease.status, LeaseStatus.returned)) {
      throw new BadRequestException(`Cannot return a lease in "${lease.status}"`);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.lease.update({
        where: { id },
        data: { status: LeaseStatus.returned, returnedAt: new Date() },
      });
      await tx.leaseReturn.create({
        data: {
          tenantId,
          leaseId: id,
          conditionGrade: dto.conditionGrade,
          assessedById: actor.id,
          assessmentNotes: dto.notes,
          feeAdjustmentMinor: dto.feeAdjustmentMinor,
          photos: (dto.photoKeys ?? []).map((s3Key) => ({
            s3Key,
          })) as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.leaseEvent.create({
        data: {
          tenantId,
          leaseId: id,
          fromStatus: lease.status,
          toStatus: LeaseStatus.returned,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          note: `Return assessed: ${dto.conditionGrade}`,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'lease.returned',
          entity: 'lease',
          entityId: id,
          after: {
            conditionGrade: dto.conditionGrade,
            feeAdjustmentMinor: dto.feeAdjustmentMinor ?? null,
          },
        },
      });
      return updated;
    });
  }

  async upgradeLease(actor: Actor, tenantId: string, id: string, dto: LeaseUpgradeDto) {
    const lease = await this.load(tenantId, id);
    if (!canLeaseTransition(lease.status, LeaseStatus.upgraded)) {
      throw new BadRequestException(`Cannot upgrade a lease in "${lease.status}"`);
    }
    const device = await this.catalog.getDeviceForPricing(tenantId, dto.newDeviceId);
    if (!device || !device.leaseEligible || !device.inStock) {
      throw new BadRequestException('The new device is not available for lease');
    }
    return this.prisma.$transaction(async (tx) => {
      // Successor lease application the customer completes for the new device (docs/07).
      const successor = await tx.application.create({
        data: {
          tenantId,
          customerId: lease.customerId,
          type: 'lease',
          deviceId: dto.newDeviceId,
        },
      });
      const updated = await tx.lease.update({
        where: { id },
        data: {
          status: LeaseStatus.upgraded,
          returnedAt: new Date(),
          successorApplicationId: successor.id,
        },
      });
      await tx.leaseEvent.create({
        data: {
          tenantId,
          leaseId: id,
          fromStatus: lease.status,
          toStatus: LeaseStatus.upgraded,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          note: `Upgrade to device ${dto.newDeviceId}`,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'lease.upgraded',
          entity: 'lease',
          entityId: id,
          after: { successorApplicationId: successor.id, newDeviceId: dto.newDeviceId },
        },
      });
      return { lease: updated, successorApplicationId: successor.id };
    });
  }

  // ---------- admin (rate/terms config) ----------
  listConfigs(tenantId: string) {
    return this.prisma.leaseRateConfig.findMany({
      where: { tenantId },
      include: { terms: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private assertOneFee(t: { monthlyFeeBps?: number; monthlyFeeMinor?: number }): void {
    const hasBps = t.monthlyFeeBps != null;
    const hasFixed = t.monthlyFeeMinor != null;
    if (hasBps === hasFixed) {
      throw new BadRequestException(
        'Each term needs exactly one of monthlyFeeBps / monthlyFeeMinor',
      );
    }
  }

  async createConfig(actor: Actor, tenantId: string, dto: CreateLeaseConfigDto) {
    dto.terms.forEach((t) => this.assertOneFee(t));
    const config = await this.prisma.leaseRateConfig.create({
      data: {
        tenantId,
        name: dto.name,
        createdById: actor.id,
        updatedById: actor.id,
        terms: {
          create: dto.terms.map((t) => ({
            tenantId,
            months: t.months,
            monthlyFeeBps: t.monthlyFeeBps ?? null,
            monthlyFeeMinor: t.monthlyFeeMinor ?? null,
            categoryId: t.categoryId ?? null,
            minPriceMinor: t.minPriceMinor ?? 0,
            maxPriceMinor: t.maxPriceMinor ?? null,
            sortOrder: t.sortOrder ?? 0,
          })),
        },
      },
      include: { terms: true },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'lease.config.created',
      entity: 'lease_rate_config',
      entityId: config.id,
      after: { name: dto.name, terms: dto.terms.length },
    });
    return config;
  }

  async updateTerm(
    actor: Actor,
    tenantId: string,
    configId: string,
    termId: string,
    dto: UpdateLeaseTermDto,
  ) {
    const before = await this.prisma.leaseRateTerm.findFirst({
      where: { id: termId, tenantId, configId },
    });
    if (!before) throw new NotFoundException('Lease term not found');

    const changes: Array<{ field: string; oldValue: string; newValue: string }> = [];
    const track = (field: keyof UpdateLeaseTermDto, oldV: number | boolean | null) => {
      const next = dto[field];
      if (next !== undefined && next !== oldV) {
        changes.push({ field, oldValue: String(oldV), newValue: String(next) });
      }
    };
    track('monthlyFeeBps', before.monthlyFeeBps);
    track('monthlyFeeMinor', before.monthlyFeeMinor);
    track('minPriceMinor', before.minPriceMinor);
    track('maxPriceMinor', before.maxPriceMinor);
    track('isActive', before.isActive);

    const [term] = await this.prisma.$transaction([
      this.prisma.leaseRateTerm.update({
        where: { id: termId },
        data: {
          monthlyFeeBps: dto.monthlyFeeBps,
          monthlyFeeMinor: dto.monthlyFeeMinor,
          minPriceMinor: dto.minPriceMinor,
          maxPriceMinor: dto.maxPriceMinor,
          isActive: dto.isActive,
        },
      }),
      ...changes.map((c) =>
        this.prisma.leaseRateHistory.create({
          data: {
            tenantId,
            rateTermId: termId,
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
            actorId: actor.id,
            actorRole: actor.roles.join(','),
          },
        }),
      ),
    ]);
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'lease.term.updated',
      entity: 'lease_rate_term',
      entityId: termId,
      before: { changes: changes.map((c) => c.field) },
      after: { ...dto },
    });
    return term;
  }

  /** Every version, newest first; the active one is what new leases snapshot. */
  listTermsTemplates(tenantId: string) {
    return this.prisma.leaseTermsTemplate.findMany({
      where: { tenantId },
      orderBy: { version: 'desc' },
    });
  }

  async createTermsTemplate(actor: Actor, tenantId: string, dto: TermsTemplateDto) {
    const latest = await this.prisma.leaseTermsTemplate.findFirst({
      where: { tenantId },
      orderBy: { version: 'desc' },
    });
    const version = (latest?.version ?? 0) + 1;
    const template = await this.prisma.$transaction(async (tx) => {
      await tx.leaseTermsTemplate.updateMany({
        where: { tenantId, isActive: true },
        data: { isActive: false },
      });
      return tx.leaseTermsTemplate.create({
        data: {
          tenantId,
          version,
          usageTerms: dto.usageTerms,
          returnConditions: dto.returnConditions,
          noOwnershipNotice: dto.noOwnershipNotice,
          isActive: true,
          createdById: actor.id,
        },
      });
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'lease.terms_template.created',
      entity: 'lease_terms_template',
      entityId: template.id,
      after: { version },
    });
    return template;
  }

  async activateConfig(actor: Actor, tenantId: string, configId: string) {
    const config = await this.prisma.leaseRateConfig.findFirst({
      where: { id: configId, tenantId },
    });
    if (!config) throw new NotFoundException('Config not found');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.leaseRateConfig.updateMany({
        where: { tenantId, isActive: true },
        data: { isActive: false },
      });
      return tx.leaseRateConfig.update({
        where: { id: configId },
        data: { isActive: true, updatedById: actor.id },
      });
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'lease.config.activated',
      entity: 'lease_rate_config',
      entityId: configId,
      after: { isActive: true },
    });
    return updated;
  }
}
