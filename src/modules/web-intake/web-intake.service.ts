import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  ApplicationStatus,
  ApplicationType,
  DeviceStatus,
  Prisma,
  Role,
  TradeInStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CatalogService } from '../catalog/catalog.service';
import { KycService } from '../kyc/kyc.service';
import { FinancingService } from '../financing/financing.service';
import { LeaseService } from '../lease/lease.service';
import { REFERENCE_PREFIX } from '../applications/application.constants';
import { WebApplicationDto } from './dto/web-application.dto';
import { decodeImageDataUrl } from './intake-files';

const ACTOR_ROLE = 'web';
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

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
  ) {}

  async submit(tenantId: string, dto: WebApplicationDto) {
    if (!dto.reference.startsWith(`${REFERENCE_PREFIX[dto.type]}-`)) {
      throw new BadRequestException('Reference does not match the application type');
    }
    const phone = dto.applicant.phone.startsWith('+')
      ? dto.applicant.phone
      : `+${dto.applicant.phone}`;

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
    const { deviceId, variantId } = await this.resolveDevice(tenantId, dto);
    const pricing = await this.price(tenantId, dto, deviceId, variantId);
    const customerId = await this.customer(tenantId, phone, dto);

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
          tradeInId,
          planSnapshot: pricing.planSnapshot,
          amountMinor: pricing.amountMinor,
          currency: pricing.currency,
          source: ACTOR_ROLE,
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
          actorRole: ACTOR_ROLE,
          note: 'Submitted from the website',
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: customerId,
          actorRole: ACTOR_ROLE,
          action: 'application.submitted_from_web',
          entity: 'application',
          entityId: created.id,
          after: { reference: created.reference, type: created.type },
        },
      });
      return created;
    });

    return this.result(app);
  }

  private result(app: { id: string; reference: string | null; status: ApplicationStatus }) {
    return { id: app.id, reference: app.reference, status: app.status };
  }

  // The website knows devices by slug and storage size; the API by ids.
  private async resolveDevice(tenantId: string, dto: WebApplicationDto) {
    const device = await this.prisma.device.findFirst({
      where: { tenantId, slug: dto.device.slug, status: DeviceStatus.published },
      include: { variants: { where: { isActive: true } } },
    });
    if (!device) throw new BadRequestException('This device is not available');

    const storage = dto.device.storage ? norm(dto.device.storage) : null;
    const color = dto.device.color ? norm(dto.device.color) : null;
    const sized = storage
      ? device.variants.filter((v) => v.storage && norm(v.storage) === storage)
      : [];
    const variant = sized.find((v) => color && v.color && norm(v.color) === color) ?? sized[0];
    return { deviceId: device.id, variantId: variant?.id ?? null };
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
  private async customer(tenantId: string, phone: string, dto: WebApplicationDto) {
    const found = await this.prisma.user.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
    });
    if (found) {
      if (found.isStaff) throw new BadRequestException('Use a customer phone number');
      await this.prisma.user.update({
        where: { id: found.id },
        data: {
          fullName: found.fullName ?? dto.applicant.fullName,
          email: found.email ?? dto.applicant.email,
        },
      });
      return found.id;
    }
    const created = await this.prisma.user.create({
      data: {
        tenantId,
        phone,
        fullName: dto.applicant.fullName,
        email: dto.applicant.email,
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
