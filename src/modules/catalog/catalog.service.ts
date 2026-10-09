import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currencyOf } from '../../common/tenancy/currency';
import { ApplicationType, DeviceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { MediaService } from './media.service';
import { AdminListDto, CreateDeviceDto, PublicListDto, UpdateDeviceDto } from './dto/device.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { CreateBrandDto, CreateCategoryDto } from './dto/taxonomy.dto';
import { ConfirmMediaDto, MediaUploadUrlDto } from './dto/media.dto';

interface Actor {
  id: string;
  roles: string[];
}

type DeviceFull = Prisma.DeviceGetPayload<{
  include: { brand: true; category: true; variants: true; media: true };
}>;

const DEVICE_INCLUDE = { brand: true, category: true, variants: true, media: true } as const;

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
  ) {}

  // ---------- shaping ----------
  private card(d: DeviceFull) {
    const active = d.variants.filter((v) => v.isActive);
    const inStock = active.filter((v) => v.stockQty > 0);
    const pool = inStock.length ? inStock : active;
    const minDelta = pool.length ? Math.min(...pool.map((v) => v.priceDeltaMinor)) : 0;
    const primary = d.media.find((m) => m.isPrimary) ?? d.media[0];
    return {
      id: d.id,
      slug: d.slug,
      name: d.name,
      summary: d.summary,
      status: d.status,
      brand: { name: d.brand.name, slug: d.brand.slug },
      category: { name: d.category.name, slug: d.category.slug },
      currency: d.currency,
      cashPriceMinor: d.cashPriceMinor,
      fromPriceMinor: d.cashPriceMinor + minDelta,
      inStock: inStock.length > 0,
      financeEligible: d.financeEligible,
      leaseEligible: d.leaseEligible,
      tradeInEligible: d.tradeInEligible,
      image: primary ? this.media.publicUrl(primary.s3Key) : null,
    };
  }

  private detail(d: DeviceFull) {
    return {
      ...this.card(d),
      specs: d.specs ?? null,
      variants: d.variants
        .filter((v) => v.isActive)
        .map((v) => ({
          id: v.id,
          sku: v.sku,
          storage: v.storage,
          color: v.color,
          priceMinor: d.cashPriceMinor + v.priceDeltaMinor,
          inStock: v.stockQty > 0,
        })),
      media: [...d.media]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((m) => ({
          url: this.media.publicUrl(m.s3Key),
          altText: m.altText,
          isPrimary: m.isPrimary,
        })),
    };
  }

  // ---------- public reads (published + in-stock) ----------
  private async queryPublic(tenantId: string, q: PublicListDto, extra?: Prisma.DeviceWhereInput) {
    const variantSome: Prisma.DeviceVariantWhereInput = { isActive: true, stockQty: { gt: 0 } };
    if (q.storage) variantSome.storage = q.storage;
    if (q.color) variantSome.color = q.color;

    const and: Prisma.DeviceWhereInput[] = [];
    if (q.q) {
      and.push({
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          { summary: { contains: q.q, mode: 'insensitive' } },
        ],
      });
    }
    if (extra) and.push(extra);

    const where: Prisma.DeviceWhereInput = {
      tenantId,
      status: DeviceStatus.published,
      publishedAt: { not: null },
      variants: { some: variantSome },
      ...(q.brand ? { brand: { slug: q.brand } } : {}),
      ...(q.category ? { category: { slug: q.category } } : {}),
      ...(q.minPriceMinor != null || q.maxPriceMinor != null
        ? { cashPriceMinor: { gte: q.minPriceMinor, lte: q.maxPriceMinor } }
        : {}),
      ...(and.length ? { AND: and } : {}),
    };

    const orderBy: Prisma.DeviceOrderByWithRelationInput =
      q.sort === 'price'
        ? { cashPriceMinor: 'asc' }
        : q.sort === 'name'
          ? { name: 'asc' }
          : { createdAt: 'desc' };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.device.count({ where }),
      this.prisma.device.findMany({
        where,
        include: DEVICE_INCLUDE,
        orderBy,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return { data: rows.map((d) => this.card(d)), total, page: q.page, limit: q.limit };
  }

  publicList(tenantId: string, q: PublicListDto) {
    return this.queryPublic(tenantId, q);
  }

  tradeLease(tenantId: string, q: PublicListDto) {
    return this.queryPublic(tenantId, q, {
      OR: [{ leaseEligible: true }, { tradeInEligible: true }],
    });
  }

  async publicDetail(tenantId: string, slug: string) {
    const d = await this.prisma.device.findFirst({
      where: { tenantId, slug, status: DeviceStatus.published, publishedAt: { not: null } },
      include: DEVICE_INCLUDE,
    });
    if (!d) throw new NotFoundException('Device not found');
    return this.detail(d);
  }

  async facets(tenantId: string) {
    const rows = await this.prisma.device.findMany({
      where: {
        tenantId,
        status: DeviceStatus.published,
        publishedAt: { not: null },
        variants: { some: { isActive: true, stockQty: { gt: 0 } } },
      },
      select: {
        cashPriceMinor: true,
        brand: { select: { name: true, slug: true } },
        category: { select: { name: true, slug: true } },
      },
    });
    const uniq = <T extends { slug: string }>(items: T[]) => [
      ...new Map(items.map((i) => [i.slug, i])).values(),
    ];
    const prices = rows.map((r) => r.cashPriceMinor);
    return {
      brands: uniq(rows.map((r) => r.brand)),
      categories: uniq(rows.map((r) => r.category)),
      priceRange: prices.length
        ? { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) }
        : null,
    };
  }

  // ---------- application eligibility gate (consumed by docs/07) ----------
  async assertDeviceSubmittable(
    tenantId: string,
    deviceId: string,
    type: ApplicationType,
  ): Promise<void> {
    const d = await this.prisma.device.findFirst({
      where: { id: deviceId, tenantId },
      include: { variants: { where: { isActive: true } } },
    });
    if (!d || d.status !== DeviceStatus.published)
      throw new BadRequestException('Device is not available');
    const eligible =
      type === ApplicationType.financing
        ? d.financeEligible
        : type === ApplicationType.lease
          ? d.leaseEligible
          : d.tradeInEligible;
    if (!eligible) throw new BadRequestException('Device is not eligible for this option');
    if (!d.variants.some((v) => v.stockQty > 0))
      throw new BadRequestException('Device is out of stock');
  }

  // Pricing snapshot for financing/lease (docs/04, docs/05). Returns the published
  // device's price, category, eligibility and stock, or null when not usable.
  async getDeviceForPricing(tenantId: string, deviceId: string) {
    const d = await this.prisma.device.findFirst({
      where: { id: deviceId, tenantId, status: DeviceStatus.published },
      include: { variants: { where: { isActive: true } } },
    });
    if (!d) return null;
    return {
      id: d.id,
      cashPriceMinor: d.cashPriceMinor,
      currency: d.currency,
      categoryId: d.categoryId,
      financeEligible: d.financeEligible,
      leaseEligible: d.leaseEligible,
      inStock: d.variants.some((v) => v.stockQty > 0),
    };
  }

  // ---------- admin ----------
  private async loadDevice(tenantId: string, id: string) {
    const d = await this.prisma.device.findFirst({
      where: { id, tenantId },
      include: DEVICE_INCLUDE,
    });
    if (!d) throw new NotFoundException('Device not found');
    return d;
  }

  async adminList(tenantId: string, q: AdminListDto) {
    const where: Prisma.DeviceWhereInput = {
      tenantId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.device.count({ where }),
      this.prisma.device.findMany({
        where,
        include: DEVICE_INCLUDE,
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return { data: rows.map((d) => this.card(d)), total, page: q.page, limit: q.limit };
  }

  async createDevice(actor: Actor, tenantId: string, dto: CreateDeviceDto) {
    const brand = await this.prisma.brand.findFirst({ where: { id: dto.brandId, tenantId } });
    const category = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, tenantId },
    });
    if (!brand || !category) throw new BadRequestException('Unknown brand or category');
    // A device is always priced in its country's currency; a different one is refused.
    const currency = currencyOf(await this.prisma.tenant.findUnique({ where: { id: tenantId } }));
    if (dto.currency && dto.currency.toUpperCase() !== currency)
      throw new BadRequestException(`Prices in this country are in ${currency}`);
    try {
      const device = await this.prisma.device.create({
        data: {
          tenantId,
          brandId: dto.brandId,
          categoryId: dto.categoryId,
          name: dto.name,
          slug: dto.slug,
          summary: dto.summary,
          cashPriceMinor: dto.cashPriceMinor,
          currency,
          financeEligible: dto.financeEligible ?? false,
          leaseEligible: dto.leaseEligible ?? false,
          tradeInEligible: dto.tradeInEligible ?? false,
          specs: dto.specs ? (dto.specs as Prisma.InputJsonValue) : undefined,
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
      await this.writeAudit(actor, tenantId, 'catalog.device.created', device.id, undefined, {
        slug: dto.slug,
      });
      return device;
    } catch (e) {
      throw this.rethrowConflict(e, 'A device with that slug already exists');
    }
  }

  async updateDevice(actor: Actor, tenantId: string, id: string, dto: UpdateDeviceDto) {
    const before = await this.loadDevice(tenantId, id);
    const device = await this.prisma.device.update({
      where: { id },
      data: {
        brandId: dto.brandId,
        categoryId: dto.categoryId,
        name: dto.name,
        summary: dto.summary,
        cashPriceMinor: dto.cashPriceMinor,
        financeEligible: dto.financeEligible,
        leaseEligible: dto.leaseEligible,
        tradeInEligible: dto.tradeInEligible,
        specs: dto.specs ? (dto.specs as Prisma.InputJsonValue) : undefined,
        updatedById: actor.id,
      },
    });
    await this.writeAudit(
      actor,
      tenantId,
      'catalog.device.updated',
      id,
      {
        cashPriceMinor: before.cashPriceMinor,
        financeEligible: before.financeEligible,
        leaseEligible: before.leaseEligible,
        tradeInEligible: before.tradeInEligible,
      },
      {
        cashPriceMinor: device.cashPriceMinor,
        financeEligible: device.financeEligible,
        leaseEligible: device.leaseEligible,
        tradeInEligible: device.tradeInEligible,
      },
    );
    return device;
  }

  async publish(actor: Actor, tenantId: string, id: string) {
    const d = await this.loadDevice(tenantId, id);
    // Images are optional until real object storage is wired (and the website may keep
    // its own photos; docs/15). A buyable variant is required.
    const hasVariant = d.variants.some((v) => v.isActive);
    if (!hasVariant) {
      throw new BadRequestException('Add at least one available variant before publishing');
    }
    const device = await this.prisma.device.update({
      where: { id },
      data: { status: DeviceStatus.published, publishedAt: new Date(), updatedById: actor.id },
    });
    await this.writeAudit(
      actor,
      tenantId,
      'catalog.device.published',
      id,
      { status: d.status },
      { status: 'published' },
    );
    return device;
  }

  async archive(actor: Actor, tenantId: string, id: string) {
    const d = await this.loadDevice(tenantId, id);
    const device = await this.prisma.device.update({
      where: { id },
      data: { status: DeviceStatus.archived, updatedById: actor.id },
    });
    await this.writeAudit(
      actor,
      tenantId,
      'catalog.device.archived',
      id,
      { status: d.status },
      { status: 'archived' },
    );
    return device;
  }

  async createVariant(actor: Actor, tenantId: string, deviceId: string, dto: CreateVariantDto) {
    await this.loadDevice(tenantId, deviceId);
    try {
      const variant = await this.prisma.deviceVariant.create({
        data: {
          tenantId,
          deviceId,
          sku: dto.sku,
          storage: dto.storage,
          color: dto.color,
          priceDeltaMinor: dto.priceDeltaMinor ?? 0,
          stockQty: dto.stockQty ?? 0,
        },
      });
      await this.writeAudit(actor, tenantId, 'catalog.variant.created', variant.id, undefined, {
        sku: dto.sku,
      });
      return variant;
    } catch (e) {
      throw this.rethrowConflict(e, 'A variant with that SKU already exists');
    }
  }

  async updateVariant(actor: Actor, tenantId: string, id: string, dto: UpdateVariantDto) {
    const before = await this.prisma.deviceVariant.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundException('Variant not found');
    const variant = await this.prisma.deviceVariant.update({
      where: { id },
      data: {
        storage: dto.storage,
        color: dto.color,
        stockQty: dto.stockQty,
        priceDeltaMinor: dto.priceDeltaMinor,
        isActive: dto.isActive,
      },
    });
    await this.writeAudit(
      actor,
      tenantId,
      'catalog.variant.updated',
      id,
      {
        stockQty: before.stockQty,
        priceDeltaMinor: before.priceDeltaMinor,
        isActive: before.isActive,
      },
      {
        stockQty: variant.stockQty,
        priceDeltaMinor: variant.priceDeltaMinor,
        isActive: variant.isActive,
      },
    );
    return variant;
  }

  async mediaUploadUrl(tenantId: string, deviceId: string, dto: MediaUploadUrlDto) {
    await this.loadDevice(tenantId, deviceId);
    return this.media.createUpload(tenantId, deviceId, dto.contentType, dto.bytes);
  }

  async confirmMedia(actor: Actor, tenantId: string, deviceId: string, dto: ConfirmMediaDto) {
    await this.loadDevice(tenantId, deviceId);
    if (!dto.s3Key.startsWith(`tenants/${tenantId}/devices/${deviceId}/`)) {
      throw new BadRequestException('s3Key does not belong to this device');
    }
    if (dto.isPrimary) {
      await this.prisma.deviceMedia.updateMany({
        where: { tenantId, deviceId },
        data: { isPrimary: false },
      });
    }
    const media = await this.prisma.deviceMedia.create({
      data: {
        tenantId,
        deviceId,
        s3Key: dto.s3Key,
        altText: dto.altText,
        isPrimary: dto.isPrimary ?? false,
      },
    });
    await this.writeAudit(actor, tenantId, 'catalog.media.added', media.id, undefined, {
      deviceId,
    });
    return { id: media.id, url: this.media.publicUrl(media.s3Key), isPrimary: media.isPrimary };
  }

  // ---------- taxonomy ----------
  async createBrand(actor: Actor, tenantId: string, dto: CreateBrandDto) {
    try {
      const brand = await this.prisma.brand.create({
        data: { tenantId, name: dto.name, slug: dto.slug },
      });
      await this.writeAudit(actor, tenantId, 'catalog.brand.created', brand.id, undefined, {
        slug: dto.slug,
      });
      return brand;
    } catch (e) {
      throw this.rethrowConflict(e, 'A brand with that slug already exists');
    }
  }

  listBrands(tenantId: string) {
    return this.prisma.brand.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(actor: Actor, tenantId: string, dto: CreateCategoryDto) {
    try {
      const category = await this.prisma.category.create({
        data: {
          tenantId,
          name: dto.name,
          slug: dto.slug,
          parentId: dto.parentId,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      await this.writeAudit(actor, tenantId, 'catalog.category.created', category.id, undefined, {
        slug: dto.slug,
      });
      return category;
    } catch (e) {
      throw this.rethrowConflict(e, 'A category with that slug already exists');
    }
  }

  listCategories(tenantId: string) {
    return this.prisma.category.findMany({
      where: { tenantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  // ---------- helpers ----------
  private writeAudit(
    actor: Actor,
    tenantId: string,
    action: string,
    entityId: string,
    before?: Prisma.InputJsonValue,
    after?: Prisma.InputJsonValue,
  ) {
    return this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action,
      entity: 'catalog',
      entityId,
      before,
      after,
    });
  }

  private rethrowConflict(e: unknown, message: string): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException(message);
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}
