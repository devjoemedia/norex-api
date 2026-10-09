import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, User, UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { assertCanGrant } from '../../common/tenancy/staff-roles';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ListUsersQueryDto } from './dto/list-users.dto';
import { CreateStaffDto } from './dto/create-staff.dto';

interface Actor {
  id: string;
  roles: string[];
}

function sanitize(user: User & { roles: UserRole[] }) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    isStaff: user.isStaff,
    roles: user.roles.map((r) => r.role),
    createdAt: user.createdAt,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async findInTenant(id: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, tenantId },
      include: { roles: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async getProfile(userId: string, tenantId: string) {
    return sanitize(await this.findInTenant(userId, tenantId));
  }

  async updateProfile(userId: string, tenantId: string, dto: UpdateProfileDto) {
    await this.findInTenant(userId, tenantId);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { fullName: dto.fullName, email: dto.email },
      include: { roles: true },
    });
    return sanitize(user);
  }

  async list(tenantId: string, query: ListUsersQueryDto) {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      tenantId,
      ...(q
        ? {
            OR: [
              { phone: { contains: q } },
              { email: { contains: q, mode: 'insensitive' } },
              { fullName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        include: { roles: true },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { data: rows.map(sanitize), total, page: query.page, limit: query.limit };
  }

  async setStatus(actor: Actor, tenantId: string, id: string, status: UserStatus, ip?: string) {
    const before = await this.findInTenant(id, tenantId);
    const updated = await this.prisma.user.update({
      where: { id },
      data: { status },
      include: { roles: true },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'user.status_changed',
      entity: 'user',
      entityId: id,
      before: { status: before.status },
      after: { status },
      ip,
    });
    return sanitize(updated);
  }

  // Provisions a staff user with a password (Argon2id) and role(s). TOTP is set up
  // by the staff member on first login (see StaffAuthService).
  async createStaff(actor: Actor, tenantId: string, dto: CreateStaffDto, ip?: string) {
    assertCanGrant(actor.roles, dto.roles);
    const existing = await this.prisma.user.findFirst({ where: { tenantId, email: dto.email } });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email: dto.email,
        fullName: dto.fullName,
        isStaff: true,
        passwordHash,
        roles: { create: dto.roles.map((role) => ({ tenantId, role })) },
      },
      include: { roles: true },
    });

    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'staff.created',
      entity: 'user',
      entityId: user.id,
      after: { email: dto.email, roles: dto.roles },
      ip,
    });
    return sanitize(user);
  }

  async assignRole(
    actor: Actor,
    tenantId: string,
    id: string,
    role: Role,
    branchId: string | undefined,
    ip?: string,
  ) {
    assertCanGrant(actor.roles, [role]);
    const user = await this.findInTenant(id, tenantId);
    const isStaff = role !== Role.customer ? true : user.isStaff;

    await this.prisma.userRole.upsert({
      where: { userId_role: { userId: id, role } },
      create: { userId: id, tenantId, role, branchId },
      update: { branchId },
    });
    await this.prisma.user.update({ where: { id }, data: { isStaff } });

    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'user.role_assigned',
      entity: 'user',
      entityId: id,
      after: { role, branchId: branchId ?? null },
      ip,
    });
    return sanitize(await this.findInTenant(id, tenantId));
  }
}
