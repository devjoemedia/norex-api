import { RiskService } from '../risk/risk.service';
import { CustomerNotifier } from '../notifications/customer-notifier.service';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ApplicationStatus, ApplicationType, Prisma, Role, TradeInStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CatalogService } from '../catalog/catalog.service';
import { KycService } from '../kyc/kyc.service';
import { FinancingService } from '../financing/financing.service';
import { LeaseService } from '../lease/lease.service';
import { REFERENCE_PREFIX } from '../applications/application.constants';
import { WebApplicationDto } from './dto/web-application.dto';
import { OrdersService } from '../orders/orders.service';
import { WebOrderDto } from '../orders/dto/order.dto';
import { decodeImageDataUrl } from './intake-files';
import type { DeviceType } from '../../common/http/client-channel';

const ACTOR_ROLE = 'web';

// Who sent a guest application: the website's server, or the mobile app (docs/19).
export interface IntakeVia {
  channel: 'website' | 'mobile_app';
  source: string;
  note: string;
  action: string;
}
const WEBSITE: IntakeVia = {
  channel: 'website',
  source: ACTOR_ROLE,
  note: 'Submitted from the website',
  action: 'application.submitted_from_web',
};
export const MOBILE_APP: IntakeVia = {
  channel: 'mobile_app',
  source: 'app',
  note: 'Submitted from the mobile app',
  action: 'application.submitted_from_app',
};
const toE164 = (p: string) => (p.startsWith('+') ? p : `+${p}`);

interface Pricing {
  planSnapshot?: Prisma.InputJsonValue;
  amountMinor?: number;
  currency: string;
}

@Injectable()
export class WebIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly kyc: KycService,
    private readonly financing: FinancingService,
    private readonly lease: LeaseService,
    private readonly orders: OrdersService,
    private readonly notifier: CustomerNotifier,
    private readonly risk: RiskService,
  ) {}

  async submit(
    tenantId: string,
    dto: WebApplicationDto,
    deviceType: DeviceType | null = null,
    via: IntakeVia = WEBSITE,
  ) {
    if (!dto.reference.startsWith(`${REFERENCE_PREFIX[dto.type]}-`)) {
      throw new BadRequestException('Reference does not match the application type');
    }
    const phone = toE164(dto.applicant.phone);

    // A retried submit (same reference, same phone) returns the first result.
    const existing = await this.prisma.application.findFirst({
      where: { tenantId, reference: dto.reference },
    });
    if (existing) {
      const owner = await this.prisma.user.findUnique({ where: { id: existing.customerId } });
      if (owner?.phone !== phone) throw new ConflictException('Reference already in use');
      return this.result(existing);
    }

    // Decode before writing anything, so a bad photo rejects the whole submit.
    const files = new Map(
      (dto.files ?? []).map((f) => [f.kind, decodeImageDataUrl(f.dataUrl)] as const),
    );
    const resolved = await this.catalog.resolveForWeb(
      tenantId,
      dto.device.slug,
      dto.device.storage,
      dto.device.color,
    );
    const deviceId = resolved.device.id;
    const variantId = resolved.variant?.id ?? null;
    const pricing = await this.price(tenantId, dto, deviceId, variantId);
    const customerId = await this.customer(tenantId, phone, dto.applicant);

    if (dto.identity) {
      await this.kyc.upsertFromIntake(tenantId, customerId, {
        idTypeCode: await this.idTypeCode(tenantId, dto.identity.idType),
        idNumber: dto.identity.idNumber,
        address: dto.identity.address,
        employment: dto.identity.employment,
        guarantor: dto.guarantor,
      });
    }

    const app = await this.prisma.$transaction(async (tx) => {
      const tradeInId =
        dto.type === ApplicationType.trade_in
          ? await this.createTradeIn(tx, tenantId, customerId, deviceId, variantId, dto)
          : undefined;
      const submittedAt = new Date();
      const created = await tx.application.create({
        data: {
          tenantId,
          customerId,
          type: dto.type,
          status: ApplicationStatus.submitted,
          reference: dto.reference,
          deviceId,
          variantId,
          financeMonths: dto.type === ApplicationType.financing ? dto.financeMonths : null,
          leaseMonths: dto.type === ApplicationType.lease ? dto.leaseMonths : null,
          upfrontMinor: dto.type === ApplicationType.financing ? dto.upfrontMinor : null,
          repaymentFrequency:
            dto.type === ApplicationType.financing
              ? (dto.repaymentFrequency ?? 'monthly')
              : 'monthly',
          tradeInId,
          planSnapshot: pricing.planSnapshot,
          amountMinor: pricing.amountMinor,
          currency: pricing.currency,
          source: via.source,
          channel: via.channel,
          deviceType,
          intakeCipher: dto.extras ? this.kyc.sealJson(dto.extras) : null,
          submittedAt,
        },
      });
      if (files.size > 0) {
        await tx.applicationFile.createMany({
          data: [...files].map(([kind, file]) => ({
            tenantId,
            applicationId: created.id,
            kind,
            contentType: file.contentType,
            sizeBytes: file.data.length,
            data: file.data,
          })),
        });
      }
      await tx.applicationEvent.create({
        data: {
          tenantId,
          applicationId: created.id,
          fromStatus: ApplicationStatus.draft,
          toStatus: ApplicationStatus.submitted,
          actorId: customerId,
          actorRole: via.source,
          note: via.note,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: customerId,
          actorRole: via.source,
          action: via.action,
          entity: 'application',
          entityId: created.id,
          after: { reference: created.reference, type: created.type },
        },
      });
      return created;
    });

    // Website and app applicants who gave an email get a confirmation (docs/10).
    await this.risk.assess(tenantId, app.id);
    await this.notifier.applicationReceived(tenantId, app.id, dto.applicant.email);
    return this.result(app);
  }

  // A cart order. Same guest identity (phone) and retry safety as applications.
  async submitOrder(tenantId: string, dto: WebOrderDto, deviceType: DeviceType | null = null) {
    const phone = toE164(dto.customer.phone);
    const existing = await this.orders.findByReference(tenantId, dto.reference);
    if (existing) {
      const owner = await this.prisma.user.findUnique({ where: { id: existing.customerId } });
      if (owner?.phone !== phone) throw new ConflictException('Reference already in use');
      return this.orders.webResult(existing);
    }
    const customerId = await this.customer(tenantId, phone, dto.customer);
    const order = await this.orders.createFromWeb(tenantId, customerId, dto, deviceType);
    await this.notifier.orderReceived(tenantId, order.id, dto.customer.email);
    return this.orders.webResult(order);
  }

  private result(app: { id: string; reference: string | null; status: ApplicationStatus }) {
    return { id: app.id, reference: app.reference, status: app.status };
  }

  // Server-side pricing (docs/04, docs/05): the website's numbers are never trusted.
  private async price(
    tenantId: string,
    dto: WebApplicationDto,
    deviceId: string,
    variantId: string | null,
  ): Promise<Pricing> {
    if (dto.type === ApplicationType.financing) {
      if (!dto.financeMonths) throw new BadRequestException('Choose a financing term');
      const snap = await this.financing.buildSnapshot(
        tenantId,
        deviceId,
        dto.financeMonths,
        dto.upfrontMinor,
        variantId,
        dto.repaymentFrequency ?? 'monthly',
      );
      return {
        planSnapshot: snap as unknown as Prisma.InputJsonValue,
        amountMinor: snap.totalPayableMinor,
        currency: snap.currency,
      };
    }
    if (dto.type === ApplicationType.lease) {
      if (!dto.leaseMonths) throw new BadRequestException('Choose a lease term');
      const snap = await this.lease.buildSnapshot(tenantId, deviceId, dto.leaseMonths, variantId);
      return {
        planSnapshot: snap as unknown as Prisma.InputJsonValue,
        amountMinor: snap.monthlyFeeMinor * snap.months,
        currency: snap.currency,
      };
    }
    if (!dto.tradeIn) throw new BadRequestException('Tell us about your current phone');
    await this.catalog.assertDeviceSubmittable(tenantId, deviceId, ApplicationType.trade_in);
    const pricing = await this.catalog.getDeviceForPricing(tenantId, deviceId, variantId);
    return { currency: pricing!.currency };
  }

  // No sign-in yet: the phone number is the customer's identity, as with OTP login.
  private async customer(
    tenantId: string,
    phone: string,
    who: { fullName: string; email?: string },
  ) {
    const found = await this.prisma.user.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
    });
    // Emails are unique per country: keep one only if nobody else has it (a person
    // re-applying from a new number, or two people sharing an address).
    const email = who.email?.trim().toLowerCase() || undefined;
    const emailFree =
      !!email &&
      !(await this.prisma.user.findFirst({
        where: { tenantId, email, ...(found ? { id: { not: found.id } } : {}) },
        select: { id: true },
      }));
    if (found) {
      if (found.isStaff) throw new BadRequestException('Use a customer phone number');
      await this.prisma.user.update({
        where: { id: found.id },
        data: {
          fullName: found.fullName ?? who.fullName,
          email: found.email ?? (emailFree ? email : undefined),
        },
      });
      return found.id;
    }
    const created = await this.prisma.user.create({
      data: {
        tenantId,
        phone,
        fullName: who.fullName,
        email: emailFree ? email : null,
        roles: { create: { tenantId, role: Role.customer } },
      },
    });
    return created.id;
  }

  // "national-id" is the country's own ID (configured per tenant); others keep their name.
  private async idTypeCode(tenantId: string, webType: string) {
    if (webType === 'national-id') {
      const config = await this.prisma.kycIdTypeConfig.findFirst({
        where: { tenantId, active: true },
        orderBy: { createdAt: 'asc' },
      });
      if (config) return config.code;
    }
    return webType.replace(/-/g, '_');
  }

  private async createTradeIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    customerId: string,
    targetDeviceId: string,
    targetVariantId: string | null,
    dto: WebApplicationDto,
  ) {
    const t = dto.tradeIn!;
    const tradeIn = await tx.tradeIn.create({
      data: {
        tenantId,
        reference: dto.reference,
        customerId,
        targetDeviceId,
        targetVariantId,
        oldBrand: t.oldBrand,
        oldModel: t.oldModel,
        oldStorage: t.oldStorage ?? null,
        conditionCode: t.conditionCode ?? null,
        accessories: t.accessories ? { text: t.accessories } : undefined,
        notes: t.notes ?? null,
        status: TradeInStatus.submitted,
        submittedAt: new Date(),
      },
    });
    await tx.tradeInEvent.create({
      data: {
        tenantId,
        tradeInId: tradeIn.id,
        fromStatus: TradeInStatus.draft,
        toStatus: TradeInStatus.submitted,
        actorId: customerId,
        actorRole: ACTOR_ROLE,
        note: 'Submitted from the website for valuation',
      },
    });
    return tradeIn.id;
  }
}
