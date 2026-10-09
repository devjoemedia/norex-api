import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Branch, BranchStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  AssignAgentDto,
  CreateBranchDto,
  ListBranchesDto,
  UpdateBranchDto,
} from './dto/branches.dto';

interface Actor {
  id: string;
  roles: string[];
}

// Public-directory projection — no staff or customer data ever leaves here.
function toPublic(b: Branch) {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    city: b.city,
    region: b.region,
    address: b.address,
    lat: b.lat,
    lng: b.lng,
    hours: b.hours,
    phone: b.phone,
    directions:
      b.lat != null && b.lng != null
        ? `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}`
        : null,
  };
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------- public directory ----------
  async publicList(tenantId: string, q: ListBranchesDto) {
    const branches = await this.prisma.branch.findMany({
      where: {
        tenantId,
        status: BranchStatus.active,
        ...(q.city ? { city: q.city } : {}),
        ...(q.region ? { region: q.region } : {}),
        ...(q.type ? { type: q.type } : {}),
      },
      orderBy: { name: 'asc' },
    });
    return branches.map(toPublic);
  }

  async publicDetail(tenantId: string, id: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id, tenantId, status: BranchStatus.active },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return toPublic(branch);
  }

  // ---------- admin ----------
  listAll(tenantId: string) {
    return this.prisma.branch.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  }

  async create(actor: Actor, tenantId: string, dto: CreateBranchDto) {
    const branch = await this.prisma.branch.create({
      data: {
        tenantId,
        name: dto.name,
        type: dto.type,
        city: dto.city,
        region: dto.region,
        address: dto.address,
        lat: dto.lat,
        lng: dto.lng,
        hours: (dto.hours ?? undefined) as Prisma.InputJsonValue | undefined,
        phone: dto.phone,
      },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'branch.created',
      entity: 'branch',
      entityId: branch.id,
      after: { name: dto.name, type: dto.type },
    });
    return branch;
  }

  async update(actor: Actor, tenantId: string, id: string, dto: UpdateBranchDto) {
    const before = await this.prisma.branch.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundException('Branch not found');
    const branch = await this.prisma.branch.update({
      where: { id },
      data: {
        name: dto.name,
        type: dto.type,
        city: dto.city,
        region: dto.region,
        address: dto.address,
        lat: dto.lat,
        lng: dto.lng,
        hours: (dto.hours ?? undefined) as Prisma.InputJsonValue | undefined,
        phone: dto.phone,
        status: dto.status,
      },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'branch.updated',
      entity: 'branch',
      entityId: id,
      before: { status: before.status },
      after: { ...dto } as Prisma.InputJsonValue,
    });
    return branch;
  }

  // Assign an existing agent to this branch. An agent staffs exactly one active branch.
  async assignAgent(actor: Actor, tenantId: string, branchId: string, dto: AssignAgentDto) {
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');
    if (branch.status !== BranchStatus.active) {
      throw new BadRequestException('Cannot assign agents to an inactive branch');
    }
    const agentRole = await this.prisma.userRole.findFirst({
      where: { userId: dto.userId, tenantId, role: Role.agent },
    });
    if (!agentRole) throw new BadRequestException('User is not an agent in this tenant');

    const updated = await this.prisma.userRole.update({
      where: { id: agentRole.id },
      data: { branchId },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'branch.agent.assigned',
      entity: 'branch',
      entityId: branchId,
      after: { userId: dto.userId },
    });
    return updated;
  }

  async unassignAgent(actor: Actor, tenantId: string, branchId: string, userId: string) {
    const agentRole = await this.prisma.userRole.findFirst({
      where: { userId, tenantId, role: Role.agent, branchId },
    });
    if (!agentRole) throw new NotFoundException('Agent is not assigned to this branch');
    const updated = await this.prisma.userRole.update({
      where: { id: agentRole.id },
      data: { branchId: null },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'branch.agent.unassigned',
      entity: 'branch',
      entityId: branchId,
      after: { userId },
    });
    return updated;
  }
}
