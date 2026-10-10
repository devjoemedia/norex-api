import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';

interface Actor {
  id: string;
  roles: string[];
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Support tickets (docs/25): a customer's question or problem from a call, WhatsApp,
// a walk-in or email, worked by staff until resolved. Every message is a staff note
// for now; customer-facing replies come with customer accounts.
@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    q: { status?: TicketStatus | 'all'; customerId?: string; mine?: boolean },
    actor: Actor,
  ) {
    const where: Prisma.SupportTicketWhereInput = {
      tenantId,
      ...(q.status && q.status !== 'all'
        ? { status: q.status }
        : q.status === 'all'
          ? {}
          : { status: { not: TicketStatus.resolved } }),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.mine ? { assignedToId: actor.id } : {}),
    };
    const [tickets, counts] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        take: 300,
        include: { _count: { select: { messages: true } } },
      }),
      this.prisma.supportTicket.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);
    const people = await this.names([
      ...tickets.map((t) => t.customerId),
      ...tickets.map((t) => t.assignedToId),
    ]);
    const count = (s: TicketStatus) => counts.find((c) => c.status === s)?._count._all ?? 0;
    return {
      stats: { open: count('open'), pending: count('pending'), resolved: count('resolved') },
      rows: tickets.map((t) => ({
        id: t.id,
        reference: t.reference,
        subject: t.subject,
        category: t.category,
        priority: t.priority,
        channel: t.channel,
        status: t.status,
        customerId: t.customerId,
        customer: t.customerId ? (people.get(t.customerId) ?? 'Customer') : null,
        assignedTo: t.assignedToId ? (people.get(t.assignedToId) ?? 'Staff') : null,
        messages: t._count.messages,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    };
  }

  async detail(tenantId: string, id: string) {
    const t = await this.prisma.supportTicket.findFirst({
      where: { tenantId, id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException('Ticket not found');
    const people = await this.names([
      t.customerId,
      t.assignedToId,
      t.createdById,
      ...t.messages.map((m) => m.authorId),
    ]);
    const customer = t.customerId
      ? await this.prisma.user.findFirst({
          where: { tenantId, id: t.customerId },
          select: { phone: true },
        })
      : null;
    return {
      id: t.id,
      reference: t.reference,
      subject: t.subject,
      category: t.category,
      priority: t.priority,
      channel: t.channel,
      status: t.status,
      customer: t.customerId
        ? {
            id: t.customerId,
            name: people.get(t.customerId) ?? 'Customer',
            phone: customer?.phone ?? null,
          }
        : null,
      assignedTo: t.assignedToId
        ? { id: t.assignedToId, name: people.get(t.assignedToId) ?? 'Staff' }
        : null,
      createdBy: t.createdById ? (people.get(t.createdById) ?? 'Staff') : null,
      createdAt: t.createdAt.toISOString(),
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      messages: t.messages.map((m) => ({
        id: m.id,
        body: m.body,
        by: m.authorId ? (people.get(m.authorId) ?? 'Staff') : 'Norex',
        at: m.createdAt.toISOString(),
      })),
    };
  }

  async create(
    tenantId: string,
    actor: Actor,
    input: {
      customerId?: string;
      subject: string;
      category: string;
      priority?: string;
      channel: string;
      message: string;
    },
  ) {
    if (input.customerId) {
      const c = await this.prisma.user.findFirst({
        where: { tenantId, id: input.customerId, isStaff: false },
      });
      if (!c) throw new NotFoundException('Customer not found');
    }
    const reference = await this.newReference(tenantId);
    const t = await this.prisma.supportTicket.create({
      data: {
        tenantId,
        reference,
        customerId: input.customerId ?? null,
        subject: input.subject.trim(),
        category: input.category,
        priority: input.priority ?? 'normal',
        channel: input.channel,
        createdById: actor.id,
        assignedToId: actor.id,
        messages: { create: { tenantId, authorId: actor.id, body: input.message.trim() } },
      },
    });
    return this.detail(tenantId, t.id);
  }

  async reply(tenantId: string, actor: Actor, id: string, body: string) {
    const t = await this.prisma.supportTicket.findFirst({ where: { tenantId, id } });
    if (!t) throw new NotFoundException('Ticket not found');
    if (t.status === TicketStatus.resolved)
      throw new ConflictException('Reopen the ticket to add to it');
    await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: { tenantId, ticketId: id, authorId: actor.id, body: body.trim() },
      }),
      this.prisma.supportTicket.update({ where: { id }, data: { updatedAt: new Date() } }),
    ]);
    return this.detail(tenantId, id);
  }

  async update(
    tenantId: string,
    actor: Actor,
    id: string,
    input: { status?: TicketStatus; assignedToId?: string | null; priority?: string },
  ) {
    const t = await this.prisma.supportTicket.findFirst({ where: { tenantId, id } });
    if (!t) throw new NotFoundException('Ticket not found');
    if (input.assignedToId) {
      const staff = await this.prisma.user.findFirst({
        where: { tenantId, id: input.assignedToId, isStaff: true, status: 'active' },
      });
      if (!staff) throw new BadRequestException('Assign to a staff member in this country');
    }
    const changes: string[] = [];
    if (input.status && input.status !== t.status) changes.push(`Status: ${input.status}`);
    if (input.priority && input.priority !== t.priority)
      changes.push(`Priority: ${input.priority}`);
    if (input.assignedToId !== undefined && input.assignedToId !== t.assignedToId)
      changes.push('Reassigned');
    await this.prisma.$transaction([
      this.prisma.supportTicket.update({
        where: { id },
        data: {
          status: input.status,
          priority: input.priority,
          assignedToId: input.assignedToId === undefined ? undefined : input.assignedToId,
          resolvedAt:
            input.status === TicketStatus.resolved ? new Date() : input.status ? null : undefined,
        },
      }),
      ...(changes.length
        ? [
            this.prisma.ticketMessage.create({
              data: { tenantId, ticketId: id, authorId: actor.id, body: changes.join(' · ') },
            }),
          ]
        : []),
    ]);
    return this.detail(tenantId, id);
  }

  // Staff may live in HQ, so names are looked up across countries.
  private async names(ids: Array<string | null>) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids.filter((x): x is string => !!x))] } },
      select: { id: true, fullName: true, email: true, phone: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName ?? u.email ?? u.phone ?? 'Someone']));
  }

  private async newReference(tenantId: string) {
    for (let i = 0; i < 5; i++) {
      const ref = `TKT-${Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('')}`;
      if (!(await this.prisma.supportTicket.findFirst({ where: { tenantId, reference: ref } })))
        return ref;
    }
    throw new ConflictException('Could not create a reference. Try again.');
  }
}
