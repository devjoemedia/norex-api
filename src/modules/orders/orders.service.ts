import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeviceUnitStatus, Order, OrderPaymentStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CatalogService } from '../catalog/catalog.service';
import { KycService } from '../kyc/kyc.service';
import { ImeiService } from '../device-units/imei.service';
import { canOrderTransition } from './order.constants';
import type { DeviceType } from '../../common/http/client-channel';
import { ConfigService } from '@nestjs/config';
import { deviceImageUrl } from '../../common/catalog/device-image';
import { ListOrdersDto, OrderActionDto, OrderHandoverDto, WebOrderDto } from './dto/order.dto';

interface Actor {
  id: string;
  roles: string[];
}

const ACTION_TO_STATUS = {
  confirm: OrderStatus.confirmed,
  ready: OrderStatus.ready,
  cancel: OrderStatus.cancelled,
} as const;

// Cash orders from the website cart (docs/18): priced from the catalog when placed,
// paid in full on collection, completed by a hand-over that stamps each unit's IMEI.
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly kyc: KycService,
    private readonly imei: ImeiService,
    private readonly config: ConfigService,
  ) {}

  // ---------- website ----------
  findByReference(tenantId: string, reference: string) {
    return this.prisma.order.findFirst({ where: { tenantId, reference } });
  }

  async createFromWeb(
    tenantId: string,
    customerId: string,
    dto: WebOrderDto,
    deviceType: DeviceType | null = null,
  ) {
    const lines = await Promise.all(
      dto.items.map(async (item) => {
        const r = await this.catalog.resolveForWeb(tenantId, item.slug, item.storage, item.color);
        return {
          deviceId: r.device.id,
          variantId: r.variant?.id ?? null,
          name: r.device.name,
          storage: r.variant?.storage ?? item.storage ?? null,
          color: r.variant?.color ?? item.color ?? null,
          currency: r.device.currency,
          unitPriceMinor: r.cashPriceMinor,
          quantity: item.quantity,
          lineTotalMinor: r.cashPriceMinor * item.quantity,
        };
      }),
    );
    const currency = lines[0].currency;
    if (lines.some((l) => l.currency !== currency)) {
      throw new BadRequestException('Items are priced in different currencies');
    }
    const f = dto.fulfilment;

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          tenantId,
          reference: dto.reference,
          customerId,
          fulfilmentMethod: f.method,
          region: f.region ?? null,
          preferredBranch: f.method === 'pickup' ? (f.branch ?? null) : null,
          addressCipher:
            f.method === 'delivery' && f.address ? this.kyc.sealJson({ text: f.address }) : null,
          notes: dto.notes ?? null,
          channel: 'website',
          deviceType,
          subtotalMinor: lines.reduce((n, l) => n + l.lineTotalMinor, 0),
          currency,
          items: {
            create: lines.map((l) => ({
              tenantId,
              deviceId: l.deviceId,
              variantId: l.variantId,
              name: l.name,
              storage: l.storage,
              color: l.color,
              unitPriceMinor: l.unitPriceMinor,
              quantity: l.quantity,
              lineTotalMinor: l.lineTotalMinor,
            })),
          },
        },
      });
      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId: order.id,
          toStatus: OrderStatus.placed,
          actorId: customerId,
          actorRole: 'web',
          note: 'Placed from the website cart',
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: customerId,
          actorRole: 'web',
          action: 'order.placed_from_web',
          entity: 'order',
          entityId: order.id,
          after: { reference: order.reference, subtotalMinor: order.subtotalMinor },
        },
      });
      return order;
    });
  }

  webResult(o: Order) {
    return {
      id: o.id,
      reference: o.reference,
      status: o.status,
      totalMinor: o.subtotalMinor,
      currency: o.currency,
    };
  }

  // ---------- admin ----------
  async list(tenantId: string, q: ListOrdersDto) {
    const orders = await this.prisma.order.findMany({
      where: { tenantId, ...(q.status ? { status: q.status } : {}) },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const customers = await this.customers(
      tenantId,
      orders.map((o) => o.customerId),
    );
    const all = await this.prisma.order.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { _all: true },
      _sum: { subtotalMinor: true },
    });
    const count = (s: OrderStatus) => all.find((a) => a.status === s)?._count._all ?? 0;
    return {
      stats: {
        placed: count(OrderStatus.placed),
        inProgress: count(OrderStatus.confirmed) + count(OrderStatus.ready),
        completed: count(OrderStatus.completed),
        cancelled: count(OrderStatus.cancelled),
        completedValueMinor:
          all.find((a) => a.status === OrderStatus.completed)?._sum.subtotalMinor ?? 0,
      },
      rows: orders.map((o) => {
        const c = customers.get(o.customerId);
        return {
          id: o.id,
          reference: o.reference,
          customerName: c?.fullName ?? '—',
          phone: c?.phone ?? null,
          items: o.items.map((i) => `${i.quantity} × ${i.name}${i.storage ? ` ${i.storage}` : ''}`),
          units: o.items.reduce((n, i) => n + i.quantity, 0),
          totalMinor: o.subtotalMinor,
          currency: o.currency,
          status: o.status,
          paymentStatus: o.paymentStatus,
          fulfilmentMethod: o.fulfilmentMethod,
          region: o.region,
          createdAt: o.createdAt.toISOString(),
        };
      }),
    };
  }

  async detail(tenantId: string, id: string) {
    const o = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: { items: true, events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!o) throw new NotFoundException('Order not found');
    const [customer, units, branch, devices] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: o.customerId } }),
      this.prisma.deviceUnit.findMany({
        where: { tenantId, orderId: o.id },
        select: { id: true, imeiLast4: true, serial: true, deviceId: true, variantId: true },
      }),
      o.branchId ? this.prisma.branch.findUnique({ where: { id: o.branchId } }) : null,
      this.prisma.device.findMany({
        where: { tenantId, id: { in: o.items.map((i) => i.deviceId) } },
        select: { id: true, specs: true },
      }),
    ]);
    const imageBase = this.config.get<string>('DEVICE_IMAGE_BASE_URL');
    const images = new Map(devices.map((d) => [d.id, deviceImageUrl(d.specs, imageBase)]));
    const address = o.addressCipher
      ? this.kyc.openJson<{ text: string }>(o.addressCipher).text
      : null;
    return {
      id: o.id,
      reference: o.reference,
      status: o.status,
      paymentStatus: o.paymentStatus,
      paymentMethod: o.paymentMethod,
      currency: o.currency,
      subtotalMinor: o.subtotalMinor,
      paidAmountMinor: o.paidAmountMinor,
      paidAt: o.paidAt?.toISOString() ?? null,
      customer: {
        id: customer?.id ?? o.customerId,
        name: customer?.fullName ?? '—',
        phone: customer?.phone ?? null,
        email: customer?.email ?? null,
      },
      fulfilment: {
        method: o.fulfilmentMethod,
        region: o.region,
        preferredBranch: o.preferredBranch,
        branchId: o.branchId,
        branchName: branch?.name ?? null,
        address,
      },
      notes: o.notes,
      cancelReason: o.cancelReason,
      items: o.items.map((i) => ({
        id: i.id,
        name: i.name,
        storage: i.storage,
        color: i.color,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        lineTotalMinor: i.lineTotalMinor,
        imageUrl: images.get(i.deviceId) ?? null,
        units: units
          .filter(
            (u) => u.deviceId === i.deviceId && (u.variantId ?? null) === (i.variantId ?? null),
          )
          .map((u) => ({ id: u.id, imeiMasked: `•••• ${u.imeiLast4}`, serial: u.serial })),
      })),
      // What the customer entered at checkout, in the same shape as applications.
      submission: [
        {
          title: 'Personal details',
          rows: [
            ['Full name', customer?.fullName ?? '—'],
            ['Phone', customer?.phone ?? '—'],
            ['Email', customer?.email ?? '—'],
          ],
        },
        {
          title: 'Pickup or delivery',
          rows: [
            ['Method', o.fulfilmentMethod === 'delivery' ? 'Delivery' : 'Pickup at a branch'],
            ['Region', o.region ?? '—'],
            o.fulfilmentMethod === 'delivery'
              ? ['Address', address ?? '—']
              : ['Preferred branch', o.preferredBranch ?? '—'],
          ],
        },
        {
          title: 'Payment',
          rows: [
            ['Method', 'Cash in full on collection'],
            ['Items', String(o.items.reduce((n, i) => n + i.quantity, 0))],
          ],
        },
        ...(o.notes ? [{ title: 'Notes from the customer', rows: [['Note', o.notes]] }] : []),
      ].map((sec) => ({
        ...sec,
        rows: (sec.rows as Array<[string, string]>).filter(([, v]) => v !== '—'),
      })),
      events: o.events.map((e) => ({
        from: e.fromStatus,
        to: e.toStatus,
        actorRole: e.actorRole,
        note: e.note,
        at: e.createdAt.toISOString(),
      })),
      createdAt: o.createdAt.toISOString(),
      completedAt: o.completedAt?.toISOString() ?? null,
    };
  }

  async act(tenantId: string, actor: Actor, id: string, dto: OrderActionDto) {
    const to = ACTION_TO_STATUS[dto.action];
    await this.move(
      tenantId,
      actor,
      id,
      to,
      {
        ...(to === OrderStatus.confirmed ? { confirmedAt: new Date() } : {}),
        ...(to === OrderStatus.ready ? { readyAt: new Date() } : {}),
        ...(to === OrderStatus.cancelled
          ? { cancelledAt: new Date(), cancelReason: dto.reason ?? null }
          : {}),
        ...(dto.branchId ? { branchId: dto.branchId } : {}),
      },
      dto.reason,
    );
    return this.detail(tenantId, id);
  }

  // Cash taken at the counter / by the courier. Must cover the full order total.
  async recordPayment(tenantId: string, actor: Actor, id: string, amountMinor: number) {
    const o = await this.load(tenantId, id);
    if (o.status !== OrderStatus.confirmed && o.status !== OrderStatus.ready) {
      throw new BadRequestException('Confirm the order before taking payment');
    }
    if (o.paymentStatus === OrderPaymentStatus.paid) return this.detail(tenantId, id);
    if (amountMinor < o.subtotalMinor) {
      throw new BadRequestException(
        'Cash orders are paid in full: the amount must cover the total',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          paymentStatus: OrderPaymentStatus.paid,
          paidAmountMinor: amountMinor,
          paidAt: new Date(),
          receivedById: actor.id,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'order.cash_received',
          entity: 'order',
          entityId: id,
          after: { amountMinor, currency: o.currency },
        },
      });
    });
    return this.detail(tenantId, id);
  }

  // Hand-over: one entry per physical unit. IMEIs are sealed (docs/18) and each becomes
  // a `sold` DeviceUnit linked to the customer and this order; stock is decremented.
  async handover(tenantId: string, actor: Actor, id: string, dto: OrderHandoverDto) {
    const o = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: { items: true },
    });
    if (!o) throw new NotFoundException('Order not found');
    if (o.status !== OrderStatus.ready) throw new BadRequestException('Mark the order ready first');
    if (o.paymentStatus !== OrderPaymentStatus.paid) {
      throw new BadRequestException('Record the cash payment before handing over');
    }
    for (const item of o.items) {
      const given = dto.units.filter((u) => u.itemId === item.id);
      if (given.length !== item.quantity) {
        throw new BadRequestException(`Enter ${item.quantity} unit(s) for ${item.name}`);
      }
    }
    if (dto.units.some((u) => !o.items.some((i) => i.id === u.itemId))) {
      throw new BadRequestException('A unit does not belong to this order');
    }
    if (dto.units.some((u) => !u.imei && !u.serial)) {
      throw new BadRequestException('Each unit needs an IMEI or a serial number');
    }
    const sealed = dto.units.map((u) => ({
      ...u,
      sealed: u.imei ? this.imei.seal(tenantId, u.imei) : null,
    }));
    const hashes = sealed.flatMap((u) => (u.sealed ? [u.sealed.imeiHash] : []));
    if (new Set(hashes).size !== hashes.length) {
      throw new BadRequestException('The same IMEI was entered twice');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const u of sealed) {
        const item = o.items.find((i) => i.id === u.itemId)!;
        if (!u.sealed) continue; // serial-only goods (no IMEI) are recorded on the event
        const existing = await tx.deviceUnit.findUnique({
          where: { tenantId_imeiHash: { tenantId, imeiHash: u.sealed.imeiHash } },
        });
        if (existing && existing.status !== DeviceUnitStatus.in_stock) {
          throw new ConflictException(
            `IMEI ending ${u.sealed.imeiLast4} is already sold or assigned`,
          );
        }
        const holder = {
          serial: u.serial ?? existing?.serial ?? null,
          deviceId: item.deviceId,
          variantId: item.variantId,
          customerId: o.customerId,
          orderId: o.id,
          branchId: o.branchId ?? existing?.branchId ?? null,
          status: DeviceUnitStatus.sold,
          activatedAt: new Date(),
        };
        if (existing) await tx.deviceUnit.update({ where: { id: existing.id }, data: holder });
        else await tx.deviceUnit.create({ data: { tenantId, ...u.sealed, ...holder } });
      }
      for (const item of o.items) {
        if (!item.variantId) continue;
        await tx.deviceVariant.updateMany({
          where: { id: item.variantId, tenantId, stockQty: { gte: item.quantity } },
          data: { stockQty: { decrement: item.quantity } },
        });
      }
      await tx.order.update({
        where: { id },
        data: { status: OrderStatus.completed, completedAt: new Date() },
      });
      const serials = sealed.filter((u) => !u.sealed).map((u) => u.serial);
      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId: id,
          fromStatus: o.status,
          toStatus: OrderStatus.completed,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          note: `Handed over ${dto.units.length} unit(s)${serials.length ? `; serials: ${serials.join(', ')}` : ''}`,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'order.handed_over',
          entity: 'order',
          entityId: id,
          after: { units: sealed.map((u) => u.sealed?.imeiLast4 ?? u.serial ?? null) },
        },
      });
    });
    return this.detail(tenantId, id);
  }

  // ---------- internals ----------
  private async load(tenantId: string, id: string) {
    const o = await this.prisma.order.findFirst({ where: { id, tenantId } });
    if (!o) throw new NotFoundException('Order not found');
    return o;
  }

  private async move(
    tenantId: string,
    actor: Actor,
    id: string,
    to: OrderStatus,
    data: Prisma.OrderUpdateInput,
    note?: string,
  ) {
    const o = await this.load(tenantId, id);
    if (!canOrderTransition(o.status, to)) {
      throw new ConflictException(`Cannot move an order from "${o.status}" to "${to}"`);
    }
    if (to === OrderStatus.cancelled && o.paymentStatus === OrderPaymentStatus.paid) {
      throw new BadRequestException('This order is paid: refund the cash before cancelling');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { ...data, status: to } });
      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId: id,
          fromStatus: o.status,
          toStatus: to,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          note: note ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: `order.${to}`,
          entity: 'order',
          entityId: id,
        },
      });
    });
  }

  private async customers(tenantId: string, ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { tenantId, id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true, phone: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }
}
