import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceUnitStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ImeiService } from './imei.service';
import { isValidImei, maskImei, normalizeImei } from './imei.util';
import { ListDeviceUnitsDto, RegisterDeviceUnitDto } from './dto/device-unit.dto';

interface Actor {
  id: string;
  roles: string[];
}

// Serialized devices by IMEI (docs/18): stock in, who holds each unit, what they're
// paying for it, and lock state. Lists only ever carry the masked IMEI.
@Injectable()
export class DeviceUnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly imei: ImeiService,
  ) {}

  async list(tenantId: string, q: ListDeviceUnitsDto) {
    const where: Prisma.DeviceUnitWhereInput = { tenantId };
    if (q.status) where.status = q.status;
    const term = q.q?.trim();
    if (term) {
      const digits = normalizeImei(term);
      // A full IMEI matches by keyed hash; 4 digits match the visible tail.
      if (isValidImei(digits)) where.imeiHash = this.imei.hash(tenantId, digits);
      else if (/^\d{4}$/.test(digits)) where.imeiLast4 = digits;
      else where.serial = { contains: term, mode: 'insensitive' };
    }

    const [units, counts] = await Promise.all([
      this.prisma.deviceUnit.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: q.limit,
        skip: (q.page - 1) * q.limit,
      }),
      this.prisma.deviceUnit.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);
    const rows = await this.decorate(tenantId, units);
    const count = (s: DeviceUnitStatus) => counts.find((c) => c.status === s)?._count._all ?? 0;
    const locked = await this.prisma.deviceUnit.count({
      where: { tenantId, lockState: { not: 'unlocked' } },
    });
    return {
      stats: {
        total: counts.reduce((n, c) => n + c._count._all, 0),
        inStock: count(DeviceUnitStatus.in_stock),
        financed: count(DeviceUnitStatus.active),
        sold: count(DeviceUnitStatus.sold),
        locked,
      },
      rows,
    };
  }

  async detail(tenantId: string, id: string) {
    const unit = await this.prisma.deviceUnit.findFirst({
      where: { id, tenantId },
      include: { lockEvents: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!unit) throw new NotFoundException('Device not found');
    const [row] = await this.decorate(tenantId, [unit]);

    // What the holder is paying for this unit (financed units only).
    const schedule = unit.applicationId
      ? await this.prisma.repaymentSchedule.findFirst({
          where: { tenantId, applicationId: unit.applicationId },
          include: { installments: { orderBy: { seq: 'asc' } } },
        })
      : null;
    const inst = schedule?.installments ?? [];
    const next = inst.find((i) => i.status !== 'paid');
    return {
      ...row,
      notes: unit.notes,
      lockProvider: unit.lockProvider,
      enrollment: unit.enrollment,
      lastLockAt: unit.lastLockAt?.toISOString() ?? null,
      repayment: schedule
        ? {
            currency: schedule.currency,
            totalMinor: schedule.totalAmountMinor,
            paidMinor: inst.reduce((n, i) => n + i.paidAmountMinor, 0),
            installmentsPaid: inst.filter((i) => i.status === 'paid').length,
            installmentsTotal: inst.length,
            overdue: inst.filter((i) => i.status === 'overdue').length,
            nextDue: next
              ? { dueDate: next.dueDate.toISOString(), amountMinor: next.amountMinor }
              : null,
            status: schedule.status,
          }
        : null,
      lockEvents: unit.lockEvents.map((e) => ({
        id: e.id,
        action: e.action,
        fromState: e.fromState,
        toState: e.toState,
        source: e.source,
        reason: e.reason,
        success: e.success,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  // Receive a unit into stock. The IMEI must be valid and new for this country.
  async register(tenantId: string, actor: Actor, dto: RegisterDeviceUnitDto) {
    const sealed = this.imei.seal(tenantId, dto.imei);
    const device = await this.prisma.device.findFirst({
      where: { id: dto.deviceId, tenantId },
      include: { variants: true },
    });
    if (!device) throw new NotFoundException('Product not found');
    if (dto.variantId && !device.variants.some((v) => v.id === dto.variantId)) {
      throw new NotFoundException('Storage option not found for this product');
    }
    try {
      const unit = await this.prisma.deviceUnit.create({
        data: {
          tenantId,
          ...sealed,
          serial: dto.serial?.trim() || null,
          deviceId: dto.deviceId,
          variantId: dto.variantId ?? null,
          branchId: dto.branchId ?? null,
          notes: dto.notes ?? null,
          status: DeviceUnitStatus.in_stock,
        },
      });
      await this.audit.write(tenantId, {
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'device_unit.registered',
        entity: 'device_unit',
        entityId: unit.id,
        after: { imeiLast4: sealed.imeiLast4, deviceId: dto.deviceId },
      });
      return { id: unit.id, imeiLast4: unit.imeiLast4 };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This IMEI is already registered');
      }
      throw e;
    }
  }

  // Full IMEI for a named reason (e.g. police report, provider enrolment). Audited.
  async reveal(tenantId: string, actor: Actor, id: string, reason: string) {
    const unit = await this.prisma.deviceUnit.findFirst({ where: { id, tenantId } });
    if (!unit) throw new NotFoundException('Device not found');
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'device_unit.imei_revealed',
      entity: 'device_unit',
      entityId: unit.id,
      after: { reason },
    });
    return { imei: this.imei.reveal(unit.imeiCipher) };
  }

  // Joins names for display without loading any IMEI plaintext.
  private async decorate(tenantId: string, units: Prisma.DeviceUnitGetPayload<object>[]) {
    const ids = (pick: (u: (typeof units)[number]) => string | null) => [
      ...new Set(units.map(pick).filter((v): v is string => !!v)),
    ];
    const [devices, variants, users, branches, apps, orders] = await Promise.all([
      this.prisma.device.findMany({
        where: { tenantId, id: { in: ids((u) => u.deviceId) } },
        select: { id: true, name: true },
      }),
      this.prisma.deviceVariant.findMany({
        where: { tenantId, id: { in: ids((u) => u.variantId) } },
        select: { id: true, storage: true, color: true },
      }),
      this.prisma.user.findMany({
        where: { tenantId, id: { in: ids((u) => u.customerId) } },
        select: { id: true, fullName: true, phone: true },
      }),
      this.prisma.branch.findMany({
        where: { tenantId, id: { in: ids((u) => u.branchId) } },
        select: { id: true, name: true },
      }),
      this.prisma.application.findMany({
        where: { tenantId, id: { in: ids((u) => u.applicationId) } },
        select: { id: true, reference: true, status: true, type: true },
      }),
      this.prisma.order.findMany({
        where: { tenantId, id: { in: ids((u) => u.orderId) } },
        select: { id: true, reference: true, status: true },
      }),
    ]);
    const by = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
    const [d, v, c, b, a, o] = [
      by(devices),
      by(variants),
      by(users),
      by(branches),
      by(apps),
      by(orders),
    ];
    return units.map((u) => {
      const variant = u.variantId ? v.get(u.variantId) : undefined;
      const customer = u.customerId ? c.get(u.customerId) : undefined;
      const app = u.applicationId ? a.get(u.applicationId) : undefined;
      const order = u.orderId ? o.get(u.orderId) : undefined;
      return {
        id: u.id,
        imeiMasked: maskImei(u.imeiLast4),
        imeiLast4: u.imeiLast4,
        serial: u.serial,
        deviceName: d.get(u.deviceId)?.name ?? '—',
        storage: variant?.storage ?? null,
        color: variant?.color ?? null,
        status: u.status,
        lockState: u.lockState,
        customer: customer
          ? { id: customer.id, name: customer.fullName ?? '—', phone: customer.phone }
          : null,
        branchName: u.branchId ? (b.get(u.branchId)?.name ?? '—') : null,
        application: app
          ? { id: app.id, reference: app.reference, status: app.status, type: app.type }
          : null,
        order: order ? { id: order.id, reference: order.reference, status: order.status } : null,
        activatedAt: u.activatedAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      };
    });
  }
}
