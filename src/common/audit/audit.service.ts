import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface AuditEvent {
  actorId?: string;
  actorRole?: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string;
  requestId?: string;
}

// Writes append-only audit entries. Runs inside the tenant RLS context so it works
// whether or not RLS is enforced on audit_log.
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tenantId: string, event: AuditEvent): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.auditLog.create({ data: { tenantId, ...event } }),
    );
  }
}
