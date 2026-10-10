import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { DeviceStatus, Prisma, TradeInQuoteStatus, TradeInStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { canTradeInTransition, REFERENCE_PREFIX } from './trade-in.constants';
import {
  ConditionOptionsDto,
  ConfirmPhotoDto,
  CreateTradeInDto,
  PhotoUploadUrlDto,
  UpdateTradeInDto,
  ValuationDto,
} from './dto/trade-in.dto';

interface Actor {
  id: string;
  roles: string[];
}

// Staff who see the tenant-wide queue (valuation is further gated to agent/country_manager).
const STAFF_ROLES = ['agent', 'country_manager', 'super_admin', 'admin'];
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class TradeInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  private isStaff(roles: string[]): boolean {
    return roles.some((r) => STAFF_ROLES.includes(r));
  }

  private reference(): string {
    let code = '';
    for (let i = 0; i < 6; i++) code += REF_ALPHABET[randomInt(0, REF_ALPHABET.length)];
    return `${REFERENCE_PREFIX}-${code}`;
  }

  private async load(tenantId: string, id: string) {
    const tradeIn = await this.prisma.tradeIn.findFirst({ where: { id, tenantId } });
    if (!tradeIn) throw new NotFoundException('Trade-in not found');
    return tradeIn;
  }

  // Customer-owned mutations (intake/photos/submit/accept) require the owning customer.
  private async loadOwned(tenantId: string, user: Actor, id: string) {
    const tradeIn = await this.load(tenantId, id);
    if (tradeIn.customerId !== user.id) throw new ForbiddenException('Not your trade-in');
    return tradeIn;
  }

  // Target-device gate: must be published, trade_in_eligible, and have in-stock variants (docs/03).
  private async assertEligibleTarget(tenantId: string, targetDeviceId: string) {
    const device = await this.prisma.device.findFirst({
      where: { id: targetDeviceId, tenantId, status: DeviceStatus.published },
      include: { variants: { where: { isActive: true } } },
    });
    if (!device) throw new BadRequestException('Target device is not available');
    if (device.tradeInEligible !== true)
      throw new BadRequestException('Target device is not eligible for trade-in');
    if (!device.variants.some((v) => v.stockQty > 0))
      throw new BadRequestException('Target device is out of stock');
    return device;
  }

  // ---------- public ----------
  conditionOptions(tenantId: string) {
    return this.prisma.tradeInConditionOption.findMany({
      where: { tenantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  // ---------- intake (customer/owner) ----------
  async create(tenantId: string, user: Actor, dto: CreateTradeInDto) {
    await this.assertEligibleTarget(tenantId, dto.targetDeviceId);
    return this.prisma.tradeIn.create({
      data: {
        tenantId,
        customerId: user.id,
        targetDeviceId: dto.targetDeviceId,
        targetVariantId: dto.targetVariantId ?? null,
        oldBrand: dto.oldBrand,
        oldModel: dto.oldModel,
        oldStorage: dto.oldStorage ?? null,
        conditionCode: dto.conditionCode ?? null,
        accessories: (dto.accessories as Prisma.InputJsonValue) ?? undefined,
        notes: dto.notes ?? null,
        status: TradeInStatus.draft,
      },
    });
  }

  async update(tenantId: string, user: Actor, id: string, dto: UpdateTradeInDto) {
    const tradeIn = await this.loadOwned(tenantId, user, id);
    if (tradeIn.status !== TradeInStatus.draft)
      throw new BadRequestException('Only a draft trade-in can be edited');
    return this.prisma.tradeIn.update({
      where: { id },
      data: {
        targetVariantId: dto.targetVariantId,
        oldBrand: dto.oldBrand,
        oldModel: dto.oldModel,
        oldStorage: dto.oldStorage,
        conditionCode: dto.conditionCode,
        notes: dto.notes,
        ...(dto.accessories !== undefined
          ? { accessories: dto.accessories as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  // Short-lived signed PUT; bytes never transit the app.
  async photoUploadUrl(tenantId: string, user: Actor, id: string, dto: PhotoUploadUrlDto) {
    const tradeIn = await this.loadOwned(tenantId, user, id);
    if (tradeIn.status !== TradeInStatus.draft)
      throw new BadRequestException('Only a draft trade-in can add photos');
    return this.storage.createImageUpload(tenantId, `trade-ins/${id}`, dto.contentType, dto.bytes);
  }

  async confirmPhoto(tenantId: string, user: Actor, id: string, dto: ConfirmPhotoDto) {
    const tradeIn = await this.loadOwned(tenantId, user, id);
    if (tradeIn.status !== TradeInStatus.draft)
      throw new BadRequestException('Only a draft trade-in can add photos');
    const sortOrder = await this.prisma.tradeInPhoto.count({ where: { tenantId, tradeInId: id } });
    return this.prisma.tradeInPhoto.create({
      data: { tenantId, tradeInId: id, s3Key: dto.s3Key, kind: dto.kind, sortOrder },
    });
  }

  // Requires ≥1 photo + a condition; stamps the reference and notifies staff (docs/10).
  async submit(tenantId: string, user: Actor, id: string) {
    const tradeIn = await this.loadOwned(tenantId, user, id);
    if (!canTradeInTransition(tradeIn.status, TradeInStatus.submitted))
      throw new BadRequestException(`Cannot submit a trade-in in "${tradeIn.status}"`);
    if (!tradeIn.conditionCode) throw new BadRequestException('A condition is required to submit');
    const photos = await this.prisma.tradeInPhoto.count({ where: { tenantId, tradeInId: id } });
    if (photos < 1) throw new BadRequestException('At least one photo is required to submit');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tradeIn.update({
        where: { id },
        data: {
          status: TradeInStatus.submitted,
          reference: this.reference(),
          submittedAt: new Date(),
        },
      });
      await tx.tradeInEvent.create({
        data: {
          tenantId,
          tradeInId: id,
          fromStatus: tradeIn.status,
          toStatus: TradeInStatus.submitted,
          actorId: user.id,
          actorRole: user.roles.join(','),
          note: 'Submitted for valuation',
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: user.id,
          actorRole: user.roles.join(','),
          action: 'trade_in.submitted',
          entity: 'trade_in',
          entityId: id,
          after: { reference: updated.reference },
        },
      });
      return updated;
    });
  }

  // ---------- reads ----------
  list(tenantId: string, user: Actor, status?: string) {
    return this.prisma.tradeIn.findMany({
      where: {
        tenantId,
        ...(this.isStaff(user.roles) ? {} : { customerId: user.id }),
        ...(status ? { status: status as TradeInStatus } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOne(tenantId: string, user: Actor, id: string) {
    const tradeIn = await this.prisma.tradeIn.findFirst({
      where: { id, tenantId },
      include: {
        photos: { orderBy: { sortOrder: 'asc' } },
        quotes: { orderBy: { createdAt: 'desc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!tradeIn) throw new NotFoundException('Trade-in not found');
    if (!this.isStaff(user.roles) && tradeIn.customerId !== user.id)
      throw new ForbiddenException('Not your trade-in');
    // Photos are only reachable via short-lived signed GET URLs.
    return {
      ...tradeIn,
      photos: tradeIn.photos.map((p) => ({ ...p, url: this.storage.signedGet(p.s3Key) })),
    };
  }

  // ---------- manual valuation (staff-only) ----------
  async valuate(actor: Actor, tenantId: string, id: string, dto: ValuationDto) {
    const tradeIn = await this.load(tenantId, id);
    // A customer cannot value their own trade-in.
    if (tradeIn.customerId === actor.id)
      throw new ForbiddenException('You cannot value your own trade-in');
    if (!canTradeInTransition(tradeIn.status, TradeInStatus.quoted))
      throw new BadRequestException(`Cannot value a trade-in in "${tradeIn.status}"`);
    const device = await this.prisma.device.findFirst({
      where: { id: tradeIn.targetDeviceId, tenantId },
    });
    if (!device) throw new BadRequestException('Target device not found');

    return this.prisma.$transaction(async (tx) => {
      // Re-valuation supersedes the prior quote and keeps history.
      await tx.tradeInQuote.updateMany({
        where: { tenantId, tradeInId: id, status: TradeInQuoteStatus.active },
        data: { status: TradeInQuoteStatus.superseded },
      });
      const quote = await tx.tradeInQuote.create({
        data: {
          tenantId,
          tradeInId: id,
          quoteValueMinor: dto.quoteValueMinor,
          topUpMinor: dto.topUpMinor ?? null,
          currency: device.currency,
          valuedById: actor.id,
          valuationNotes: dto.notes ?? null,
          expiresAt: new Date(dto.expiresAt),
          status: TradeInQuoteStatus.active,
        },
      });
      const updated = await tx.tradeIn.update({
        where: { id },
        data: { status: TradeInStatus.quoted },
      });
      await tx.tradeInEvent.create({
        data: {
          tenantId,
          tradeInId: id,
          fromStatus: tradeIn.status,
          toStatus: TradeInStatus.quoted,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          note: 'Manual valuation',
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'trade_in.valued',
          entity: 'trade_in',
          entityId: id,
          after: {
            quoteId: quote.id,
            quoteValueMinor: dto.quoteValueMinor,
            topUpMinor: dto.topUpMinor ?? null,
          },
        },
      });
      return { tradeIn: updated, quote };
    });
  }

  // ---------- accept (customer/owner) ----------
  async accept(tenantId: string, user: Actor, id: string) {
    const tradeIn = await this.loadOwned(tenantId, user, id);
    if (!canTradeInTransition(tradeIn.status, TradeInStatus.accepted))
      throw new BadRequestException(`Cannot accept a trade-in in "${tradeIn.status}"`);
    const quote = await this.prisma.tradeInQuote.findFirst({
      where: { tenantId, tradeInId: id, status: TradeInQuoteStatus.active },
    });
    if (!quote) throw new BadRequestException('No active quote to accept');
    if (quote.expiresAt <= new Date()) throw new BadRequestException('The quote has expired');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tradeIn.update({
        where: { id },
        data: { status: TradeInStatus.accepted },
      });
      await tx.tradeInEvent.create({
        data: {
          tenantId,
          tradeInId: id,
          fromStatus: tradeIn.status,
          toStatus: TradeInStatus.accepted,
          actorId: user.id,
          actorRole: user.roles.join(','),
          note: 'Quote accepted',
        },
      });
      // No money moves here; quote.topUpMinor is the hand-off value for docs/07.
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: user.id,
          actorRole: user.roles.join(','),
          action: 'trade_in.accepted',
          entity: 'trade_in',
          entityId: id,
          after: { quoteId: quote.id, topUpMinor: quote.topUpMinor ?? null },
        },
      });
      return updated;
    });
  }

  // Logic a BullMQ cron would call: expire quoted trade-ins whose active quote has lapsed.
  async expireStaleQuotes(tenantId: string): Promise<number> {
    const stale = await this.prisma.tradeIn.findMany({
      where: {
        tenantId,
        status: TradeInStatus.quoted,
        quotes: {
          some: { status: TradeInQuoteStatus.active, expiresAt: { lt: new Date() } },
        },
      },
      select: { id: true, status: true },
    });
    if (stale.length === 0) return 0;
    for (const t of stale) {
      await this.prisma.$transaction(async (tx) => {
        await tx.tradeIn.update({ where: { id: t.id }, data: { status: TradeInStatus.expired } });
        await tx.tradeInEvent.create({
          data: {
            tenantId,
            tradeInId: t.id,
            fromStatus: t.status,
            toStatus: TradeInStatus.expired,
            note: 'Quote expired',
          },
        });
      });
    }
    return stale.length;
  }

  // ---------- admin (condition-options config) ----------
  listConditionOptions(tenantId: string) {
    return this.prisma.tradeInConditionOption.findMany({
      where: { tenantId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  // Replace-set of the per-tenant condition options (audited).
  async upsertConditionOptions(actor: Actor, tenantId: string, dto: ConditionOptionsDto) {
    await this.prisma.$transaction([
      this.prisma.tradeInConditionOption.deleteMany({ where: { tenantId } }),
      this.prisma.tradeInConditionOption.createMany({
        data: dto.options.map((o, i) => ({
          tenantId,
          code: o.code,
          label: o.label,
          description: o.description ?? null,
          sortOrder: o.sortOrder ?? i,
          isActive: o.isActive ?? true,
        })),
      }),
    ]);
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'trade_in.condition_options.updated',
      entity: 'trade_in_condition_option',
      entityId: tenantId,
      after: { count: dto.options.length },
    });
    return this.listConditionOptions(tenantId);
  }
}
