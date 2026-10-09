import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Application, ApplicationStatus, ApplicationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { CatalogService } from '../catalog/catalog.service';
import { KycService } from '../kyc/kyc.service';
import { FinancingService } from '../financing/financing.service';
import { LeaseService } from '../lease/lease.service';
import { PaymentsService } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  canTransition,
  DecisionAction,
  isDecisionStaff,
  REFERENCE_PREFIX,
} from './application.constants';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { DecisionDto } from './dto/decision.dto';
import { ListApplicationsDto } from './dto/list-applications.dto';

interface Requester {
  id: string;
  roles: string[];
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
    private readonly catalog: CatalogService,
    private readonly kyc: KycService,
    private readonly financing: FinancingService,
    private readonly lease: LeaseService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  private reference(type: ApplicationType): string {
    let code = '';
    for (let i = 0; i < 6; i++) code += REF_ALPHABET[randomInt(0, REF_ALPHABET.length)];
    return `${REFERENCE_PREFIX[type]}-${code}`;
  }

  private async load(tenantId: string, id: string): Promise<Application> {
    const app = await this.prisma.application.findFirst({ where: { id, tenantId } });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  private assertOwner(app: Application, user: Requester): void {
    if (app.customerId !== user.id) throw new ForbiddenException('Not your application');
  }

  // Everything the application needs before it can be submitted. The device must be
  // published, eligible for this type, and in stock (docs/03); KYC must be complete
  // (docs/08). For financing, we recompute an immutable pricing snapshot (docs/04)
  // server-side so the terms cannot be tampered with client-side.
  private async assertSubmittable(app: Application): Promise<Prisma.ApplicationUpdateInput> {
    if (app.type === ApplicationType.lease && ![6, 12].includes(app.leaseMonths ?? 0)) {
      throw new BadRequestException('Choose a 6- or 12-month lease term');
    }
    await this.catalog.assertDeviceSubmittable(app.tenantId, app.deviceId, app.type);
    const kyc = await this.kyc.isComplete(app.tenantId, app.customerId);
    if (!kyc.complete) {
      throw new BadRequestException(
        `Complete your verification first: missing ${kyc.missing.join(', ')}`,
      );
    }

    if (app.type === ApplicationType.financing) {
      if (!app.financeMonths) throw new BadRequestException('Choose a financing term');
      const snapshot = await this.financing.buildSnapshot(
        app.tenantId,
        app.deviceId,
        app.financeMonths,
        app.upfrontMinor ?? undefined,
        app.variantId,
      );
      return {
        planSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        amountMinor: snapshot.totalPayableMinor,
        currency: snapshot.currency,
      };
    }

    if (app.type === ApplicationType.lease) {
      // Immutable lease snapshot (fee + term + terms version) captured server-side,
      // consumed at activation by the payments schedule generator (docs/05, docs/09).
      const snapshot = await this.lease.buildSnapshot(
        app.tenantId,
        app.deviceId,
        app.leaseMonths as number,
        app.variantId,
      );
      return {
        planSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        amountMinor: snapshot.monthlyFeeMinor * snapshot.months,
        currency: snapshot.currency,
      };
    }
    return {};
  }

  async create(tenantId: string, user: Requester, dto: CreateApplicationDto) {
    return this.prisma.application.create({
      data: {
        tenantId,
        customerId: user.id,
        type: dto.type,
        deviceId: dto.deviceId,
        financeMonths: dto.financeMonths,
        leaseMonths: dto.leaseMonths,
        upfrontMinor: dto.upfrontMinor,
        tradeInId: dto.tradeInId,
        planSnapshot: dto.planSnapshot ? (dto.planSnapshot as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async update(tenantId: string, user: Requester, id: string, dto: UpdateApplicationDto) {
    const app = await this.load(tenantId, id);
    this.assertOwner(app, user);
    if (app.status !== ApplicationStatus.draft && app.status !== ApplicationStatus.info_requested) {
      throw new ConflictException(`Cannot edit an application in "${app.status}"`);
    }
    return this.prisma.application.update({
      where: { id },
      data: {
        deviceId: dto.deviceId,
        financeMonths: dto.financeMonths,
        leaseMonths: dto.leaseMonths,
        upfrontMinor: dto.upfrontMinor,
        tradeInId: dto.tradeInId,
        planSnapshot: dto.planSnapshot ? (dto.planSnapshot as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async getOne(tenantId: string, user: Requester, id: string) {
    const app = await this.prisma.application.findFirst({
      where: { id, tenantId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!app) throw new NotFoundException('Application not found');
    if (!isDecisionStaff(user.roles) && app.customerId !== user.id) {
      throw new ForbiddenException('Not your application');
    }
    return app;
  }

  async list(tenantId: string, user: Requester, query: ListApplicationsDto) {
    const staff = isDecisionStaff(user.roles);
    const where: Prisma.ApplicationWhereInput = {
      tenantId,
      ...(staff ? {} : { customerId: user.id }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.application.count({ where }),
      this.prisma.application.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { data, total, page: query.page, limit: query.limit };
  }

  async submit(tenantId: string, user: Requester, id: string, idemKey?: string) {
    if (idemKey) {
      const state = await this.idem.begin(tenantId, idemKey, 'app.submit');
      if (!state.firstTime) return this.getOne(tenantId, user, state.resultRef ?? id);
    }

    const app = await this.prisma.$transaction(async (tx) => {
      const current = await tx.application.findFirst({ where: { id, tenantId } });
      if (!current) throw new NotFoundException('Application not found');
      this.assertOwner(current, user);
      if (!canTransition(current.status, ApplicationStatus.submitted)) {
        throw new ConflictException(`Cannot submit from "${current.status}"`);
      }
      const pricing = await this.assertSubmittable(current);

      const updated = await tx.application.update({
        where: { id },
        data: {
          ...pricing,
          status: ApplicationStatus.submitted,
          reference: current.reference ?? this.reference(current.type),
          submittedAt: new Date(),
        },
      });
      await tx.applicationEvent.create({
        data: {
          tenantId,
          applicationId: id,
          fromStatus: current.status,
          toStatus: ApplicationStatus.submitted,
          actorId: user.id,
          actorRole: user.roles.join(','),
        },
      });
      return updated;
    });

    if (idemKey) await this.idem.complete(tenantId, idemKey, app.id);
    // TODO: notify the customer (docs/10).
    return app;
  }

  async withdraw(tenantId: string, user: Requester, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const app = await tx.application.findFirst({ where: { id, tenantId } });
      if (!app) throw new NotFoundException('Application not found');
      this.assertOwner(app, user);
      if (!canTransition(app.status, ApplicationStatus.withdrawn)) {
        throw new ConflictException(`Cannot withdraw from "${app.status}"`);
      }
      const updated = await tx.application.update({
        where: { id },
        data: { status: ApplicationStatus.withdrawn },
      });
      await tx.applicationEvent.create({
        data: {
          tenantId,
          applicationId: id,
          fromStatus: app.status,
          toStatus: ApplicationStatus.withdrawn,
          actorId: user.id,
          actorRole: user.roles.join(','),
        },
      });
      return updated;
    });
  }

  async review(tenantId: string, user: Requester, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const app = await tx.application.findFirst({ where: { id, tenantId } });
      if (!app) throw new NotFoundException('Application not found');
      if (!canTransition(app.status, ApplicationStatus.under_review)) {
        throw new ConflictException(`Cannot start review from "${app.status}"`);
      }
      const updated = await tx.application.update({
        where: { id },
        data: { status: ApplicationStatus.under_review, reviewerId: user.id },
      });
      await tx.applicationEvent.create({
        data: {
          tenantId,
          applicationId: id,
          fromStatus: app.status,
          toStatus: ApplicationStatus.under_review,
          actorId: user.id,
          actorRole: user.roles.join(','),
        },
      });
      return updated;
    });
  }

  async decide(tenantId: string, user: Requester, id: string, dto: DecisionDto, idemKey?: string) {
    if (
      (dto.decision === DecisionAction.request_info || dto.decision === DecisionAction.decline) &&
      !dto.reason?.trim()
    ) {
      throw new BadRequestException('A reason is required for this decision');
    }
    const target =
      dto.decision === DecisionAction.approve
        ? ApplicationStatus.approved
        : dto.decision === DecisionAction.request_info
          ? ApplicationStatus.info_requested
          : ApplicationStatus.declined;

    if (idemKey) {
      const state = await this.idem.begin(tenantId, idemKey, 'app.decision');
      if (!state.firstTime) return this.getOne(tenantId, user, state.resultRef ?? id);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const app = await tx.application.findFirst({ where: { id, tenantId } });
      if (!app) throw new NotFoundException('Application not found');
      if (app.status !== ApplicationStatus.under_review) {
        throw new ConflictException(
          `Only an application under review can be decided (was "${app.status}")`,
        );
      }
      if (!canTransition(app.status, target)) {
        throw new ConflictException(`Cannot move "${app.status}" -> "${target}"`);
      }
      const updated = await tx.application.update({
        where: { id },
        data: {
          status: target,
          decidedAt: new Date(),
          decidedById: user.id,
          declineReason: dto.decision === DecisionAction.decline ? dto.reason : null,
        },
      });
      await tx.applicationEvent.create({
        data: {
          tenantId,
          applicationId: id,
          fromStatus: app.status,
          toStatus: target,
          actorId: user.id,
          actorRole: user.roles.join(','),
          note: dto.note ?? dto.reason,
        },
      });
      return { updated, from: app.status };
    });

    await this.audit.write(tenantId, {
      actorId: user.id,
      actorRole: user.roles.join(','),
      action: 'application.decision',
      entity: 'application',
      entityId: id,
      before: { status: result.from },
      after: { status: target, decision: dto.decision, reason: dto.reason ?? null },
    });

    if (idemKey) await this.idem.complete(tenantId, idemKey, id);

    // Notify the customer of the decision (docs/10). Best-effort — emit never throws.
    await this.notifications.emit({
      tenantId,
      eventKey: 'application_status',
      userId: result.updated.customerId,
      entityId: `${id}:${target}`,
      vars: {
        reference: result.updated.reference ?? '',
        status: target,
        reason: dto.reason ?? '',
      },
    });
    // TODO: schedule + fulfilment on approve (docs/09, docs/12).
    return result.updated;
  }

  // Customer e-signs the agreement: approved -> agreement_pending (docs/07). The e-sign
  // artefact itself is docs/07 scope; here we record the transition so the deposit +
  // activation flow (docs/09) can proceed.
  async acceptAgreement(tenantId: string, user: Requester, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const app = await tx.application.findFirst({ where: { id, tenantId } });
      if (!app) throw new NotFoundException('Application not found');
      this.assertOwner(app, user);
      if (!canTransition(app.status, ApplicationStatus.agreement_pending)) {
        throw new ConflictException(`Cannot accept an agreement from "${app.status}"`);
      }
      const updated = await tx.application.update({
        where: { id },
        data: { status: ApplicationStatus.agreement_pending },
      });
      await tx.applicationEvent.create({
        data: {
          tenantId,
          applicationId: id,
          fromStatus: app.status,
          toStatus: ApplicationStatus.agreement_pending,
          actorId: user.id,
          actorRole: user.roles.join(','),
        },
      });
      return updated;
    });
  }

  // Staff activates a signed application whose deposit has settled: generates the
  // repayment schedule and moves it to active (docs/09 owns the schedule/ledger).
  async activate(tenantId: string, user: Requester, id: string) {
    const schedule = await this.payments.activateFromApplication(tenantId, user, id);
    // A lease application also spins up the lease record on activation (docs/05).
    const app = await this.load(tenantId, id);
    if (app.type === ApplicationType.lease) {
      await this.lease.createFromApplication(tenantId, user, app);
    }
    return schedule;
  }
}
