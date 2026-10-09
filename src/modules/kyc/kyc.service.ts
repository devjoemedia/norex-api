import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { KycDocKind, KycProfile, KycStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { keyedHash } from '../../common/crypto/hash.util';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';
import {
  ConfirmDocDto,
  GuarantorDto,
  KycProfileDto,
  ListProfilesDto,
  UploadDocDto,
  VerifyDecision,
  VerifyDto,
} from './dto/kyc.dto';

interface Actor {
  id: string;
  roles: string[];
}
interface Ctx {
  ip?: string;
  requestId?: string;
}

const DOC_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const BASE_REQUIRED_DOCS: KycDocKind[] = [
  KycDocKind.id_front,
  KycDocKind.id_back,
  KycDocKind.proof_of_address,
];

export interface KycCompleteness {
  complete: boolean;
  missing: string[];
}

@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  // ---------- crypto (single app key; production uses per-record DEK + KMS, docs/01) ----------
  private encKey(): string {
    return this.config.get<string>('ENCRYPTION_KEY') ?? this.config.get<string>('JWT_SECRET')!;
  }
  private idHashKey(tenantId: string): string {
    return `${this.config.get<string>('JWT_SECRET')}:kyc:${tenantId}`;
  }
  private encStr(s: string): string {
    return encryptSecret(s, this.encKey());
  }
  private decStr(c: string): string {
    return decryptSecret(c, this.encKey());
  }
  private encJson(o: unknown): string {
    return this.encStr(JSON.stringify(o));
  }
  private decJson<T>(c: string): T {
    return JSON.parse(this.decStr(c)) as T;
  }

  // ---------- storage (stub signed URLs; production signs against S3, docs/00) ----------
  private storageBase(): string {
    const endpoint = this.config.get<string>('S3_ENDPOINT') ?? 'https://storage.local';
    const bucket = this.config.get<string>('S3_BUCKET') ?? 'norex-kyc';
    return `${endpoint}/${bucket}`;
  }
  private signedUpload(storageKey: string): string {
    return `${this.storageBase()}/${storageKey}?stub-signed-put&exp=${Date.now() + 300_000}`;
  }
  private signedDownload(storageKey: string): string {
    return `${this.storageBase()}/${storageKey}?stub-signed-get&exp=${Date.now() + 120_000}`;
  }

  private async logAccess(
    tenantId: string,
    actor: Actor,
    kycProfileId: string,
    action: string,
    documentId: string | undefined,
    ctx: Ctx,
  ) {
    await this.prisma.kycAccessLog.create({
      data: {
        tenantId,
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        kycProfileId,
        documentId,
        action,
        ip: ctx.ip,
        requestId: ctx.requestId,
      },
    });
  }

  private masked(p: KycProfile) {
    return {
      id: p.id,
      idTypeCode: p.idTypeCode,
      idNumberLast4: p.idNumberLast4,
      status: p.status,
      rejectReason: p.rejectReason,
      updatedAt: p.updatedAt,
    };
  }

  // ---------- config ----------
  getIdTypes(tenantId: string) {
    return this.prisma.kycIdTypeConfig.findMany({
      where: { tenantId, active: true },
      select: { code: true, label: true, numberRegex: true, requiresSelfie: true },
    });
  }

  // ---------- completeness gate (consumed by docs/07) ----------
  async isComplete(tenantId: string, customerId: string): Promise<KycCompleteness> {
    const profile = await this.prisma.kycProfile.findUnique({
      where: { tenantId_customerId: { tenantId, customerId } },
      include: { guarantor: true, documents: true },
    });
    const missing: string[] = [];
    if (!profile)
      return {
        complete: false,
        missing: [
          'id_type',
          'id_number',
          'address',
          'employment',
          'guarantor',
          ...BASE_REQUIRED_DOCS,
        ],
      };

    const config = profile.idTypeCode
      ? await this.prisma.kycIdTypeConfig.findFirst({
          where: { tenantId, code: profile.idTypeCode, active: true },
        })
      : null;
    if (!config) missing.push('id_type');
    if (!profile.idNumberHash) missing.push('id_number');
    if (!profile.addressCipher) missing.push('address');
    if (!profile.employmentCipher) missing.push('employment');
    if (!profile.guarantor) missing.push('guarantor');

    const required = [
      ...BASE_REQUIRED_DOCS,
      ...(config?.requiresSelfie ? [KycDocKind.selfie] : []),
    ];
    for (const kind of required) {
      if (!profile.documents.some((d) => d.kind === kind)) missing.push(kind);
    }
    return { complete: missing.length === 0, missing };
  }

  // ---------- customer ----------
  private async getOrCreateProfile(tenantId: string, customerId: string): Promise<KycProfile> {
    const existing = await this.prisma.kycProfile.findUnique({
      where: { tenantId_customerId: { tenantId, customerId } },
    });
    return existing ?? this.prisma.kycProfile.create({ data: { tenantId, customerId } });
  }

  async getMe(tenantId: string, customerId: string) {
    const profile = await this.prisma.kycProfile.findUnique({
      where: { tenantId_customerId: { tenantId, customerId } },
    });
    return {
      profile: profile ? this.masked(profile) : null,
      completeness: await this.isComplete(tenantId, customerId),
    };
  }

  async putMe(tenantId: string, customerId: string, dto: KycProfileDto) {
    const config = await this.prisma.kycIdTypeConfig.findFirst({
      where: { tenantId, code: dto.idTypeCode, active: true },
    });
    if (!config) throw new BadRequestException('Unknown or inactive ID type');
    if (!new RegExp(config.numberRegex).test(dto.idNumber))
      throw new BadRequestException('ID number format is invalid');

    const fields = {
      idTypeCode: dto.idTypeCode,
      idNumberCipher: this.encStr(dto.idNumber),
      idNumberLast4: dto.idNumber.slice(-4),
      idNumberHash: keyedHash(this.idHashKey(tenantId), dto.idNumber),
      addressCipher: this.encJson(dto.address),
      employmentCipher: this.encJson(dto.employment),
      // Editing resets the review; re-submission after rejection returns to pending.
      status: KycStatus.pending,
      reviewedById: null,
      reviewedAt: null,
      rejectReason: null,
    };
    try {
      const profile = await this.prisma.kycProfile.upsert({
        where: { tenantId_customerId: { tenantId, customerId } },
        create: { tenantId, customerId, ...fields },
        update: fields,
      });
      return {
        profile: this.masked(profile),
        completeness: await this.isComplete(tenantId, customerId),
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This ID number is already registered');
      }
      throw e;
    }
  }

  async putGuarantor(tenantId: string, customerId: string, dto: GuarantorDto) {
    const profile = await this.getOrCreateProfile(tenantId, customerId);
    const data = {
      tenantId,
      fullNameCipher: this.encStr(dto.fullName),
      phoneCipher: this.encStr(dto.phone),
      relationship: dto.relationship,
      addressCipher: dto.address ? this.encJson(dto.address) : null,
    };
    await this.prisma.kycGuarantor.upsert({
      where: { kycProfileId: profile.id },
      create: { kycProfileId: profile.id, ...data },
      update: data,
    });
    return { completeness: await this.isComplete(tenantId, customerId) };
  }

  // Encrypts any applicant JSON with the KYC key (e.g. a website application's extras).
  sealJson(o: unknown): string {
    return this.encJson(o);
  }

  // Website guest intake (docs/16): saves what the form collected without the
  // signed-in ID-format gate. The profile stays pending until staff review it.
  async upsertFromIntake(
    tenantId: string,
    customerId: string,
    input: {
      idTypeCode: string;
      idNumber: string;
      address?: Record<string, unknown>;
      employment?: Record<string, unknown>;
      guarantor?: GuarantorDto;
    },
  ) {
    const idNumber = input.idNumber.trim();
    const fields = {
      idTypeCode: input.idTypeCode,
      idNumberCipher: this.encStr(idNumber),
      idNumberLast4: idNumber.slice(-4),
      idNumberHash: keyedHash(this.idHashKey(tenantId), idNumber),
      ...(input.address ? { addressCipher: this.encJson(input.address) } : {}),
      ...(input.employment ? { employmentCipher: this.encJson(input.employment) } : {}),
      status: KycStatus.pending,
      reviewedById: null,
      reviewedAt: null,
      rejectReason: null,
    };
    try {
      await this.prisma.kycProfile.upsert({
        where: { tenantId_customerId: { tenantId, customerId } },
        create: { tenantId, customerId, ...fields },
        update: fields,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This ID number is already registered to another phone number');
      }
      throw e;
    }
    if (input.guarantor) await this.putGuarantor(tenantId, customerId, input.guarantor);
  }

  private validateDoc(contentType: string, bytes: number): string {
    const ext = DOC_TYPES[contentType];
    if (!ext) throw new BadRequestException('Unsupported document type (png, jpeg, webp, pdf)');
    if (bytes <= 0 || bytes > MAX_DOC_BYTES)
      throw new BadRequestException('Document exceeds the 10MB limit');
    return ext;
  }

  async docUploadUrl(tenantId: string, customerId: string, dto: UploadDocDto) {
    const ext = this.validateDoc(dto.contentType, dto.bytes);
    const profile = await this.getOrCreateProfile(tenantId, customerId);
    const storageKey = `tenants/${tenantId}/kyc/${profile.id}/${dto.kind}-${randomUUID()}.${ext}`;
    return { uploadUrl: this.signedUpload(storageKey), storageKey, expiresIn: 300 };
  }

  async confirmDoc(
    tenantId: string,
    customerId: string,
    dto: ConfirmDocDto,
    actor: Actor,
    ctx: Ctx,
  ) {
    this.validateDoc(dto.contentType, dto.bytes);
    const profile = await this.getOrCreateProfile(tenantId, customerId);
    if (!dto.storageKey.startsWith(`tenants/${tenantId}/kyc/${profile.id}/`)) {
      throw new BadRequestException('storageKey does not belong to your profile');
    }
    // One document per kind — replace any previous.
    await this.prisma.kycDocument.deleteMany({
      where: { tenantId, kycProfileId: profile.id, kind: dto.kind },
    });
    const doc = await this.prisma.kycDocument.create({
      data: {
        tenantId,
        kycProfileId: profile.id,
        kind: dto.kind,
        storageKey: dto.storageKey,
        contentType: dto.contentType,
        sizeBytes: dto.bytes,
        sha256: dto.sha256,
        uploadedById: actor.id,
      },
    });
    await this.logAccess(tenantId, actor, profile.id, 'sign_url', doc.id, ctx);
    return { id: doc.id, kind: doc.kind, status: doc.status };
  }

  async myDocUrl(tenantId: string, actor: Actor, docId: string, ctx: Ctx) {
    const doc = await this.prisma.kycDocument.findFirst({
      where: { id: docId, tenantId },
      include: { profile: true },
    });
    if (!doc || doc.profile.customerId !== actor.id)
      throw new NotFoundException('Document not found');
    await this.logAccess(tenantId, actor, doc.kycProfileId, 'sign_url', doc.id, ctx);
    return { url: this.signedDownload(doc.storageKey), expiresIn: 120 };
  }

  // ---------- staff ----------
  private async loadProfile(tenantId: string, id: string) {
    const p = await this.prisma.kycProfile.findFirst({
      where: { id, tenantId },
      include: { guarantor: true, documents: true },
    });
    if (!p) throw new NotFoundException('KYC profile not found');
    return p;
  }

  async listProfiles(tenantId: string, query: ListProfilesDto) {
    const where: Prisma.KycProfileWhereInput = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.kycProfile.count({ where }),
      this.prisma.kycProfile.findMany({
        where,
        include: { guarantor: { select: { id: true } }, documents: { select: { kind: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    // PII-safe: last4 only, no ID number, no document bodies.
    const data = rows.map((p) => ({
      id: p.id,
      customerId: p.customerId,
      idTypeCode: p.idTypeCode,
      idNumberLast4: p.idNumberLast4,
      status: p.status,
      hasGuarantor: !!p.guarantor,
      documentKinds: p.documents.map((d) => d.kind),
      updatedAt: p.updatedAt,
    }));
    return { data, total, page: query.page, limit: query.limit };
  }

  // Full profile including the decrypted ID number — an explicit, logged action.
  async getProfile(tenantId: string, actor: Actor, id: string, ctx: Ctx) {
    const p = await this.loadProfile(tenantId, id);
    await this.logAccess(tenantId, actor, p.id, 'view_id_number', undefined, ctx);
    return {
      id: p.id,
      customerId: p.customerId,
      idTypeCode: p.idTypeCode,
      idNumber: p.idNumberCipher ? this.decStr(p.idNumberCipher) : null,
      address: p.addressCipher ? this.decJson(p.addressCipher) : null,
      employment: p.employmentCipher ? this.decJson(p.employmentCipher) : null,
      guarantor: p.guarantor
        ? {
            fullName: this.decStr(p.guarantor.fullNameCipher),
            phone: this.decStr(p.guarantor.phoneCipher),
            relationship: p.guarantor.relationship,
            address: p.guarantor.addressCipher ? this.decJson(p.guarantor.addressCipher) : null,
          }
        : null,
      documents: p.documents.map((d) => ({
        id: d.id,
        kind: d.kind,
        status: d.status,
        contentType: d.contentType,
      })),
      status: p.status,
      rejectReason: p.rejectReason,
    };
  }

  async staffDocUrl(tenantId: string, actor: Actor, id: string, docId: string, ctx: Ctx) {
    const doc = await this.prisma.kycDocument.findFirst({
      where: { id: docId, tenantId, kycProfileId: id },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.logAccess(tenantId, actor, id, 'sign_url', doc.id, ctx);
    return { url: this.signedDownload(doc.storageKey), expiresIn: 120 };
  }

  async verify(tenantId: string, actor: Actor, id: string, dto: VerifyDto, ctx: Ctx) {
    if (dto.decision === VerifyDecision.reject && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to reject');
    }
    const before = await this.loadProfile(tenantId, id);
    if (before.status !== KycStatus.pending) {
      throw new ConflictException(
        `Only a pending profile can be reviewed (was "${before.status}")`,
      );
    }
    const status = dto.decision === VerifyDecision.verify ? KycStatus.verified : KycStatus.rejected;
    const updated = await this.prisma.kycProfile.update({
      where: { id },
      data: {
        status,
        reviewedById: actor.id,
        reviewedAt: new Date(),
        rejectReason: status === KycStatus.rejected ? dto.reason : null,
      },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'kyc.reviewed',
      entity: 'kyc_profile',
      entityId: id,
      before: { status: before.status },
      after: { status, reason: dto.reason ?? null },
      ip: ctx.ip,
    });
    // TODO: notify the customer (docs/10).
    return this.masked(updated);
  }
}
