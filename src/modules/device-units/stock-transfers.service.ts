import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeviceUnitStatus, Prisma, StockTransferStatus } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { isValidImei, normalizeImei } from './imei.util';
import { ImeiService } from './imei.service';

interface Actor {
  id: string;
  roles: string[];
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Who can send stock; agents may only receive into their own outlet.
const MOVER_ROLES = ['super_admin', 'admin', 'country_manager', 'product_editor'];

export interface CreateTransferInput {
  fromBranchId?: string | null;
  toBranchId: string;
  unitIds: string[];
  note?: string;
}

// Phones moving between the warehouse and outlets (docs/22). While in transit the
// units are `dispatched`, so they can't be sold or sent anywhere else.
@Injectable()
export class StockTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly imei: ImeiService,
  ) {}

  async list(tenantId: string, status?: StockTransferStatus) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [transfers, inTransit, receivedThisMonth, stockGroups, branches] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where: { tenantId, ...(status ? { status } : {}) },
        include: { _count: { select: { units: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.stockTransfer.count({ where: { tenantId, status: 'in_transit' } }),
      this.prisma.stockTransfer.count({
        where: { tenantId, status: 'received', receivedAt: { gte: monthStart } },
      }),
      this.prisma.deviceUnit.groupBy({
        by: ['branchId', 'deviceId'],
        where: { tenantId, status: DeviceUnitStatus.in_stock },
        _count: { _all: true },
      }),
      this.prisma.branch.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const models = await this.prisma.device.findMany({
      where: { tenantId, id: { in: [...new Set(stockGroups.map((g) => g.deviceId))] } },
      select: { id: true, name: true },
    });
    const modelName = new Map(models.map((m) => [m.id, m.name]));

    // Stock on hand per location (null = warehouse / not yet at an outlet).
    const byLocation = new Map<
      string,
      {
        branchId: string | null;
        total: number;
        models: { deviceId: string; name: string; count: number }[];
      }
    >();
    for (const g of stockGroups) {
      const key = g.branchId ?? 'warehouse';
      const loc = byLocation.get(key) ?? { branchId: g.branchId, total: 0, models: [] };
      loc.total += g._count._all;
      loc.models.push({
        deviceId: g.deviceId,
        name: modelName.get(g.deviceId) ?? 'Device',
        count: g._count._all,
      });
      byLocation.set(key, loc);
    }
    const stock = [...byLocation.values()]
      .map((l) => ({
        ...l,
        name: l.branchId ? (branchName.get(l.branchId) ?? 'Outlet') : 'Warehouse',
        models: l.models.sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.total - a.total);

    return {
      stats: {
        inTransit,
        receivedThisMonth,
        inStock: stock.reduce((n, l) => n + l.total, 0),
        locations: stock.length,
      },
      stock,
      rows: transfers.map((t) => ({
        id: t.id,
        reference: t.reference,
        from: t.fromBranchId ? (branchName.get(t.fromBranchId) ?? 'Outlet') : 'Warehouse',
        to: branchName.get(t.toBranchId) ?? 'Outlet',
        toBranchId: t.toBranchId,
        units: t._count.units,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        receivedAt: t.receivedAt?.toISOString() ?? null,
      })),
    };
  }

  /** In-stock units at one location, for picking what to send. */
  async available(tenantId: string, fromBranchId: string | null, q?: string) {
    const where: Prisma.DeviceUnitWhereInput = {
      tenantId,
      status: DeviceUnitStatus.in_stock,
      branchId: fromBranchId,
    };
    const term = q?.trim();
    if (term) {
      const digits = normalizeImei(term);
      if (isValidImei(digits)) where.imeiHash = this.imei.hash(tenantId, digits);
      else if (/^\d{4}$/.test(digits)) where.imeiLast4 = digits;
      else where.serial = { contains: term, mode: 'insensitive' };
    }
    const units = await this.prisma.deviceUnit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.describe(tenantId, units);
  }

  async detail(tenantId: string, id: string) {
    const t = await this.prisma.stockTransfer.findFirst({
      where: { id, tenantId },
      include: { units: true },
    });
    if (!t) throw new NotFoundException('Transfer not found');
    const [units, branches, people] = await Promise.all([
      this.prisma.deviceUnit.findMany({
        where: { tenantId, id: { in: t.units.map((u) => u.unitId) } },
      }),
      this.prisma.branch.findMany({
        where: {
          tenantId,
          id: { in: [t.fromBranchId, t.toBranchId].filter((x): x is string => !!x) },
        },
        select: { id: true, name: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [t.createdById, t.receivedById].filter((x): x is string => !!x) } },
        select: { id: true, fullName: true, email: true },
      }),
    ]);
    const branch = new Map(branches.map((b) => [b.id, b.name]));
    const person = new Map(people.map((p) => [p.id, p.fullName ?? p.email ?? 'Staff']));
    return {
      id: t.id,
      reference: t.reference,
      status: t.status,
      from: t.fromBranchId ? (branch.get(t.fromBranchId) ?? 'Outlet') : 'Warehouse',
      to: branch.get(t.toBranchId) ?? 'Outlet',
      toBranchId: t.toBranchId,
      note: t.note,
      createdAt: t.createdAt.toISOString(),
      createdBy: t.createdById ? (person.get(t.createdById) ?? 'Staff (HQ)') : null,
      receivedAt: t.receivedAt?.toISOString() ?? null,
      receivedBy: t.receivedById ? (person.get(t.receivedById) ?? 'Staff') : null,
      cancelledAt: t.cancelledAt?.toISOString() ?? null,
      units: await this.describe(tenantId, units),
    };
  }

  async create(tenantId: string, actor: Actor, input: CreateTransferInput) {
    const from = input.fromBranchId ?? null;
    const ids = [...new Set(input.unitIds)];
    if (ids.length === 0) throw new BadRequestException('Pick at least one phone to send');
    if (from === input.toBranchId) {
      throw new BadRequestException('Choose a different outlet to send to');
    }
    const to = await this.prisma.branch.findFirst({ where: { tenantId, id: input.toBranchId } });
    if (!to) throw new NotFoundException('Destination outlet not found');
    if (from && !(await this.prisma.branch.findFirst({ where: { tenantId, id: from } }))) {
      throw new NotFoundException('Source outlet not found');
    }

    const reference = await this.newReference(tenantId);
    const transfer = await this.prisma.$transaction(async (tx) => {
      // Only units that are in stock at the source move; anything else fails the batch.
      const moved = await tx.deviceUnit.updateMany({
        where: { tenantId, id: { in: ids }, status: DeviceUnitStatus.in_stock, branchId: from },
        data: { status: DeviceUnitStatus.dispatched },
      });
      if (moved.count !== ids.length) {
        throw new ConflictException(
          'Some phones are no longer in stock at that location. Refresh and pick again.',
        );
      }
      return tx.stockTransfer.create({
        data: {
          tenantId,
          reference,
          fromBranchId: from,
          toBranchId: input.toBranchId,
          note: input.note?.trim() || null,
          createdById: actor.id,
          units: { create: ids.map((unitId) => ({ tenantId, unitId })) },
        },
      });
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'stock.transfer_sent',
      entity: 'stock_transfer',
      entityId: transfer.id,
      after: { reference, from, to: input.toBranchId, units: ids.length },
    });
    return this.detail(tenantId, transfer.id);
  }

  async receive(tenantId: string, actor: Actor, id: string) {
    const t = await this.open(tenantId, id);
    await this.assertCanReceive(tenantId, actor, t.toBranchId);
    await this.prisma.$transaction(async (tx) => {
      const unitIds = (await tx.stockTransferUnit.findMany({ where: { transferId: id } })).map(
        (u) => u.unitId,
      );
      await tx.deviceUnit.updateMany({
        where: { tenantId, id: { in: unitIds }, status: DeviceUnitStatus.dispatched },
        data: { status: DeviceUnitStatus.in_stock, branchId: t.toBranchId },
      });
      await tx.stockTransfer.update({
        where: { id },
        data: { status: 'received', receivedAt: new Date(), receivedById: actor.id },
      });
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'stock.transfer_received',
      entity: 'stock_transfer',
      entityId: id,
    });
    return this.detail(tenantId, id);
  }

  async cancel(tenantId: string, actor: Actor, id: string) {
    const t = await this.open(tenantId, id);
    if (!actor.roles.some((r) => MOVER_ROLES.includes(r))) {
      throw new ForbiddenException('Only operations staff or managers can cancel a transfer');
    }
    await this.prisma.$transaction(async (tx) => {
      const unitIds = (await tx.stockTransferUnit.findMany({ where: { transferId: id } })).map(
        (u) => u.unitId,
      );
      // Back where they came from.
      await tx.deviceUnit.updateMany({
        where: { tenantId, id: { in: unitIds }, status: DeviceUnitStatus.dispatched },
        data: { status: DeviceUnitStatus.in_stock, branchId: t.fromBranchId },
      });
      await tx.stockTransfer.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'stock.transfer_cancelled',
      entity: 'stock_transfer',
      entityId: id,
    });
    return this.detail(tenantId, id);
  }

  // ---------- internals ----------

  private async open(tenantId: string, id: string) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, tenantId } });
    if (!t) throw new NotFoundException('Transfer not found');
    if (t.status !== 'in_transit') {
      throw new ConflictException(`This transfer is already ${t.status.replace('_', ' ')}`);
    }
    return t;
  }

  // Agents receive only into the outlet they're assigned to.
  private async assertCanReceive(tenantId: string, actor: Actor, toBranchId: string) {
    if (actor.roles.some((r) => MOVER_ROLES.includes(r))) return;
    const role = await this.prisma.userRole.findFirst({
      where: { tenantId, userId: actor.id, role: 'agent' },
    });
    if (role?.branchId !== toBranchId) {
      throw new ForbiddenException('You can only receive stock for your own outlet');
    }
  }

  private async describe(tenantId: string, units: Prisma.DeviceUnitGetPayload<object>[]) {
    const models = await this.prisma.device.findMany({
      where: { tenantId, id: { in: [...new Set(units.map((u) => u.deviceId))] } },
      select: { id: true, name: true },
    });
    const variants = await this.prisma.deviceVariant.findMany({
      where: {
        tenantId,
        id: { in: [...new Set(units.map((u) => u.variantId).filter((v): v is string => !!v))] },
      },
      select: { id: true, storage: true, color: true },
    });
    const name = new Map(models.map((m) => [m.id, m.name]));
    const variant = new Map(
      variants.map((v) => [v.id, [v.storage, v.color].filter(Boolean).join(' ')]),
    );
    return units.map((u) => ({
      id: u.id,
      model: name.get(u.deviceId) ?? 'Device',
      variant: u.variantId ? (variant.get(u.variantId) ?? null) : null,
      imeiLast4: u.imeiLast4,
      serial: u.serial,
      status: u.status,
    }));
  }

  private async newReference(tenantId: string): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const ref = `TRF-${Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('')}`;
      if (!(await this.prisma.stockTransfer.findFirst({ where: { tenantId, reference: ref } }))) {
        return ref;
      }
    }
    throw new ConflictException('Could not create a reference. Try again.');
  }
}
