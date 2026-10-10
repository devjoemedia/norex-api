import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationStatus,
  DeviceUnitStatus,
  Fulfilment,
  FulfilmentStatus,
  IdVerifyMethod,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApplicationsService } from '../applications/applications.service';
import { KycService } from '../kyc/kyc.service';
import { ImeiService } from '../device-units/imei.service';
import { HandoverDto, VerifyIdDto } from './dto/fulfilment.dto';

interface Actor {
  id: string;
  roles: string[];
}

const CROSS_BRANCH_ROLES = ['country_manager', 'super_admin'];
// Application states an agent may pick up at the branch (post-approval).
const PICKABLE: ApplicationStatus[] = [
  ApplicationStatus.approved,
  ApplicationStatus.agreement_pending,
];

@Injectable()
export class FulfilmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
    private readonly kyc: KycService,
    private readonly imei: ImeiService,
  ) {}

  // The branch this agent staffs. Branch scope is resource-level, enforced here — an
  // agent may only act within their own branch (docs/12).
  private async agentBranch(tenantId: string, actorId: string): Promise<string> {
    const role = await this.prisma.userRole.findFirst({
      where: { userId: actorId, tenantId, role: Role.agent },
    });
    if (!role?.branchId) throw new ForbiddenException('You are not assigned to a branch');
    return role.branchId;
  }

  private async loadForAgent(
    tenantId: string,
    branchId: string,
    applicationId: string,
  ): Promise<Fulfilment> {
    const f = await this.prisma.fulfilment.findFirst({ where: { tenantId, applicationId } });
    if (!f) throw new NotFoundException('No hand-over in progress for this application');
    if (f.branchId !== branchId)
      throw new ForbiddenException('This hand-over belongs to another branch');
    return f;
  }

  // Agent looks up an approved application by reference within their branch scope.
  async lookup(tenantId: string, actor: Actor, reference: string) {
    const branchId = await this.agentBranch(tenantId, actor.id);
    const app = await this.prisma.application.findFirst({ where: { tenantId, reference } });
    if (!app || !PICKABLE.includes(app.status)) {
      throw new NotFoundException('No approved application for that reference');
    }

    // One hand-over per application; created (pending) on first lookup, scoped to branch.
    let fulfilment = await this.prisma.fulfilment.findFirst({
      where: { tenantId, applicationId: app.id },
    });
    if (fulfilment && fulfilment.branchId !== branchId) {
      throw new ForbiddenException('This application is being handled by another branch');
    }
    if (!fulfilment) {
      fulfilment = await this.prisma.fulfilment.create({
        data: {
          tenantId,
          applicationId: app.id,
          branchId,
          agentId: actor.id,
          deviceId: app.deviceId,
        },
      });
    }

    const kyc = await this.kyc.getMe(tenantId, app.customerId); // masked summary only
    return {
      application: {
        id: app.id,
        reference: app.reference,
        type: app.type,
        status: app.status,
        deviceId: app.deviceId,
        amountMinor: app.amountMinor,
        currency: app.currency,
        planSnapshot: app.planSnapshot,
      },
      kyc,
      fulfilment,
    };
  }

  // Records the ID check against the KYC record. manual_override requires a note and
  // is flagged for review + audited (docs/12).
  async verifyId(tenantId: string, actor: Actor, applicationId: string, dto: VerifyIdDto) {
    const branchId = await this.agentBranch(tenantId, actor.id);
    const f = await this.loadForAgent(tenantId, branchId, applicationId);
    if (dto.method === IdVerifyMethod.manual_override && !dto.note?.trim()) {
      throw new BadRequestException('A note is required for a manual ID override');
    }
    const updated = await this.prisma.fulfilment.update({
      where: { id: f.id },
      data: { idVerified: true, idVerifiedMethod: dto.method, notes: dto.note ?? f.notes },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action:
        dto.method === IdVerifyMethod.manual_override
          ? 'fulfilment.id.manual_override'
          : 'fulfilment.id.verified',
      entity: 'fulfilment',
      entityId: f.id,
      after: { method: dto.method, applicationId },
    });
    return updated;
  }

  // Hand-over: requires prior ID verification; activates the repayment schedule and
  // moves the application approved/agreement_pending → active (docs/07/09), then marks
  // the fulfilment fulfilled. Idempotent per (tenant, application).
  async handover(tenantId: string, actor: Actor, applicationId: string, dto: HandoverDto) {
    const branchId = await this.agentBranch(tenantId, actor.id);
    const f = await this.loadForAgent(tenantId, branchId, applicationId);
    if (f.status === FulfilmentStatus.fulfilled) return f; // idempotent
    if (!f.idVerified) throw new BadRequestException('Verify the customer ID before hand-over');

    const app = await this.prisma.application.findFirst({ where: { id: applicationId, tenantId } });
    if (!app) throw new NotFoundException('Application not found');
    if (app.status !== ApplicationStatus.agreement_pending) {
      throw new BadRequestException(
        'Application is not ready for hand-over (agreement must be signed first)',
      );
    }

    // Activation owns its own transaction (schedule + app→active + lease for leases).
    const schedule = await this.applications.activate(tenantId, actor, applicationId);

    // Mark fulfilled and, when an IMEI was captured, bind the serialized DeviceUnit in
    // the same transaction: a unit already received into stock becomes active, else
    // one is created. The IMEI is stored encrypted + hashed (docs/18), never plain.
    // Remote-lock enrollment stays `not_enrolled` until a device-control provider is
    // wired (Device Lock / POS step 4 — docs/features/12, 21, 22).
    const sealed = dto.imei ? this.imei.seal(tenantId, dto.imei) : null;
    const updated = await this.prisma.$transaction(async (tx) => {
      let deviceUnitId: string | null = null;
      if (sealed) {
        const existing = await tx.deviceUnit.findUnique({
          where: { tenantId_imeiHash: { tenantId, imeiHash: sealed.imeiHash } },
        });
        if (existing?.customerId && existing.customerId !== app.customerId) {
          throw new ConflictException('This IMEI is already assigned to another customer');
        }
        const holder = {
          serial: dto.serial ?? existing?.serial ?? null,
          deviceId: f.deviceId ?? app.deviceId,
          variantId: app.variantId ?? existing?.variantId ?? null,
          customerId: app.customerId,
          applicationId,
          fulfilmentId: f.id,
          branchId,
          status: DeviceUnitStatus.active,
          activatedAt: new Date(),
        };
        const unit = existing
          ? await tx.deviceUnit.update({ where: { id: existing.id }, data: holder })
          : await tx.deviceUnit.create({ data: { tenantId, ...sealed, ...holder } });
        deviceUnitId = unit.id;
      }
      return tx.fulfilment.update({
        where: { id: f.id },
        data: {
          status: FulfilmentStatus.fulfilled,
          fulfilledAt: new Date(),
          serial: dto.serial ?? null,
          imeiLast4: sealed?.imeiLast4 ?? null,
          deviceUnitId,
          notes: dto.note ?? f.notes,
        },
      });
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'fulfilment.handover',
      entity: 'fulfilment',
      entityId: f.id,
      after: {
        applicationId,
        branchId,
        serial: dto.serial ?? null,
        imeiLast4: sealed?.imeiLast4 ?? null,
        deviceUnitId: updated.deviceUnitId,
      },
    });
    // TODO: notify customer of hand-over (docs/10).
    return { fulfilment: updated, schedule };
  }

  async list(tenantId: string, actor: Actor, status?: string) {
    const crossBranch = actor.roles.some((r) => CROSS_BRANCH_ROLES.includes(r));
    const where = {
      tenantId,
      ...(status ? { status: status as FulfilmentStatus } : {}),
      ...(crossBranch ? {} : { branchId: await this.agentBranch(tenantId, actor.id) }),
    };
    return this.prisma.fulfilment.findMany({ where, orderBy: { createdAt: 'desc' } });
  }
}
