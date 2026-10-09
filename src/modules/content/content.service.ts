import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentEntry, ContentStatus, ContentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { sanitizeContentBody } from './sanitize.util';
import {
  CreateContentDto,
  ListContentDto,
  MediaSignDto,
  PublishDto,
  SiteConfigDto,
  UpdateContentDto,
} from './dto/content.dto';

interface Actor {
  id: string;
  roles: string[];
}

const DEFAULT_LOCALE = 'en';
const CONTENT_TYPES = Object.values(ContentType);

type EntryWithRefs = Prisma.ContentEntryGetPayload<{ include: { references: true } }>;

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ---------- shaping ----------
  // Resolve a published entry to its pinned version body + references. A real resolver
  // would join the owning modules (docs/04-06 rate config, docs/12 agents/branches) to
  // project their live values; here we return the refs so callers resolve them read-time.
  private async shape(entry: EntryWithRefs) {
    const version = entry.currentVersionId
      ? await this.prisma.contentVersion.findFirst({
          where: { id: entry.currentVersionId, tenantId: entry.tenantId },
        })
      : null;
    return {
      id: entry.id,
      type: entry.type,
      slug: entry.slug,
      locale: entry.locale,
      title: entry.title,
      status: entry.status,
      publishedAt: entry.publishedAt,
      version: version?.version ?? null,
      body: version?.body ?? null,
      meta: version?.meta ?? null,
      // TODO: resolve references against the owning modules' public projection (docs/11).
      references: entry.references.map((r) => ({ refType: r.refType, refId: r.refId })),
    };
  }

  private assertType(type: string): ContentType {
    if (!CONTENT_TYPES.includes(type as ContentType)) {
      throw new BadRequestException(`Unknown content type "${type}"`);
    }
    return type as ContentType;
  }

  private async load(tenantId: string, id: string): Promise<ContentEntry> {
    const entry = await this.prisma.contentEntry.findFirst({ where: { id, tenantId } });
    if (!entry) throw new NotFoundException('Content not found');
    return entry;
  }

  private latestVersion(tenantId: string, entryId: string) {
    return this.prisma.contentVersion.findFirst({
      where: { tenantId, entryId },
      orderBy: { version: 'desc' },
    });
  }

  // ---------- public reads (published only) ----------
  async publicList(tenantId: string, type: string, opts: { locale?: string; slug?: string }) {
    const t = this.assertType(type);
    const base: Prisma.ContentEntryWhereInput = {
      tenantId,
      type: t,
      status: ContentStatus.published,
      ...(opts.slug ? { slug: opts.slug } : {}),
    };
    const query = (locale?: string) =>
      this.prisma.contentEntry.findMany({
        where: { ...base, ...(locale ? { locale } : {}) },
        include: { references: true },
        orderBy: { publishedAt: 'desc' },
      });

    let entries = await query(opts.locale);
    // Locale fallback: when a requested non-default locale has nothing, serve 'en'.
    if (opts.locale && opts.locale !== DEFAULT_LOCALE && entries.length === 0) {
      entries = await query(DEFAULT_LOCALE);
    }
    return Promise.all(entries.map((e) => this.shape(e)));
  }

  async publicDetail(tenantId: string, type: string, slug: string, locale?: string) {
    const t = this.assertType(type);
    const find = (loc?: string) =>
      this.prisma.contentEntry.findFirst({
        where: {
          tenantId,
          type: t,
          slug,
          status: ContentStatus.published,
          ...(loc ? { locale: loc } : {}),
        },
        include: { references: true },
      });

    let entry = await find(locale);
    if (!entry && locale && locale !== DEFAULT_LOCALE) entry = await find(DEFAULT_LOCALE);
    if (!entry) throw new NotFoundException('Content not found');
    return this.shape(entry);
  }

  // ---------- admin reads (all statuses) ----------
  adminList(tenantId: string, filters: ListContentDto) {
    return this.prisma.contentEntry.findMany({
      where: {
        tenantId,
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.locale ? { locale: filters.locale } : {}),
        ...(filters.slug ? { slug: filters.slug } : {}),
      },
      include: { references: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  versions(tenantId: string, id: string) {
    return this.load(tenantId, id).then(() =>
      this.prisma.contentVersion.findMany({
        where: { tenantId, entryId: id },
        orderBy: { version: 'desc' },
      }),
    );
  }

  // ---------- admin writes ----------
  // Create a draft entry with version 1; live copy (currentVersionId) stays unset until publish.
  async create(actor: Actor, tenantId: string, dto: CreateContentDto) {
    const body = sanitizeContentBody(dto.body) as Prisma.InputJsonValue;
    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.contentEntry.create({
        data: {
          tenantId,
          type: dto.type,
          slug: dto.slug,
          locale: dto.locale ?? DEFAULT_LOCALE,
          title: dto.title,
          status: ContentStatus.draft,
          createdById: actor.id,
          updatedById: actor.id,
          references: dto.references?.length
            ? {
                create: dto.references.map((r) => ({
                  tenantId,
                  refType: r.refType,
                  refId: r.refId,
                })),
              }
            : undefined,
        },
      });
      const version = await tx.contentVersion.create({
        data: {
          tenantId,
          entryId: entry.id,
          version: 1,
          body,
          meta: dto.meta ? (dto.meta as Prisma.InputJsonValue) : undefined,
          authorId: actor.id,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'content.created',
          entity: 'content_entry',
          entityId: entry.id,
          after: { type: dto.type, slug: dto.slug ?? null, version: 1 },
        },
      });
      return { entry, version };
    });
  }

  // Edit appends a NEW version snapshot; the live currentVersionId is never touched, so
  // editing a published entry cannot change live content until it is re-published.
  async update(actor: Actor, tenantId: string, id: string, dto: UpdateContentDto) {
    await this.load(tenantId, id);
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.contentVersion.findFirst({
        where: { tenantId, entryId: id },
        orderBy: { version: 'desc' },
      });
      if (!latest) throw new BadRequestException('Entry has no version to edit');
      const nextVersion = latest.version + 1;
      const body =
        dto.body !== undefined
          ? (sanitizeContentBody(dto.body) as Prisma.InputJsonValue)
          : (latest.body as Prisma.InputJsonValue);
      const meta =
        dto.meta !== undefined
          ? (dto.meta as Prisma.InputJsonValue)
          : latest.meta != null
            ? (latest.meta as Prisma.InputJsonValue)
            : undefined;
      const version = await tx.contentVersion.create({
        data: { tenantId, entryId: id, version: nextVersion, body, meta, authorId: actor.id },
      });
      const entry = await tx.contentEntry.update({
        where: { id },
        data: { title: dto.title ?? undefined, updatedById: actor.id },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'content.updated',
          entity: 'content_entry',
          entityId: id,
          after: { version: nextVersion },
        },
      });
      return { entry, version };
    });
  }

  // Publish now pins the latest version live; a future publishAt schedules it instead.
  async publish(actor: Actor, tenantId: string, id: string, dto: PublishDto) {
    await this.load(tenantId, id);
    const now = new Date();
    const publishAt = dto.publishAt ? new Date(dto.publishAt) : null;

    if (publishAt && publishAt.getTime() > now.getTime()) {
      const entry = await this.prisma.contentEntry.update({
        where: { id },
        data: { status: ContentStatus.scheduled, publishAt, updatedById: actor.id },
      });
      await this.audit.write(tenantId, {
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'content.scheduled',
        entity: 'content_entry',
        entityId: id,
        after: { publishAt: publishAt.toISOString() },
      });
      return entry;
    }

    const latest = await this.latestVersion(tenantId, id);
    if (!latest) throw new BadRequestException('Nothing to publish — no version exists');
    const entry = await this.prisma.contentEntry.update({
      where: { id },
      data: {
        status: ContentStatus.published,
        currentVersionId: latest.id,
        publishedAt: now,
        publishAt: null,
        updatedById: actor.id,
      },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'content.published',
      entity: 'content_entry',
      entityId: id,
      after: { version: latest.version },
    });
    // TODO: emit cache/CDN surrogate-key invalidation for (tenant,type,slug,locale) — docs/11.
    return entry;
  }

  // Remove from public reads: back to draft and unpin the live version.
  async unpublish(actor: Actor, tenantId: string, id: string) {
    const before = await this.load(tenantId, id);
    const entry = await this.prisma.contentEntry.update({
      where: { id },
      data: {
        status: ContentStatus.draft,
        currentVersionId: null,
        publishedAt: null,
        publishAt: null,
        updatedById: actor.id,
      },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'content.unpublished',
      entity: 'content_entry',
      entityId: id,
      before: { status: before.status },
      after: { status: ContentStatus.draft },
    });
    // TODO: emit cache invalidation so the CDN drops the now-unpublished copy — docs/11.
    return entry;
  }

  // Revert re-publishes a prior version by appending a copy as the newest version and
  // pinning it (append-only history, fully audited) — the old rows are never mutated.
  async revert(actor: Actor, tenantId: string, id: string, version: number) {
    await this.load(tenantId, id);
    const source = await this.prisma.contentVersion.findFirst({
      where: { tenantId, entryId: id, version },
    });
    if (!source) throw new NotFoundException(`Version ${version} not found`);
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.contentVersion.findFirst({
        where: { tenantId, entryId: id },
        orderBy: { version: 'desc' },
      });
      const nextVersion = (latest?.version ?? 0) + 1;
      const copy = await tx.contentVersion.create({
        data: {
          tenantId,
          entryId: id,
          version: nextVersion,
          body: source.body as Prisma.InputJsonValue,
          meta: source.meta != null ? (source.meta as Prisma.InputJsonValue) : undefined,
          authorId: actor.id,
        },
      });
      const entry = await tx.contentEntry.update({
        where: { id },
        data: {
          status: ContentStatus.published,
          currentVersionId: copy.id,
          publishedAt: new Date(),
          publishAt: null,
          updatedById: actor.id,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: 'content.reverted',
          entity: 'content_entry',
          entityId: id,
          after: { revertedTo: version, newVersion: nextVersion },
        },
      });
      return { entry, version: copy };
    });
  }

  // Flip due scheduled entries to published (pin the latest version). This is the method
  // a BullMQ cron would call at the tick; no BullMQ in this codebase yet (docs/11).
  async runScheduledPublish(tenantId: string) {
    const now = new Date();
    const due = await this.prisma.contentEntry.findMany({
      where: { tenantId, status: ContentStatus.scheduled, publishAt: { lte: now } },
    });
    const published: string[] = [];
    for (const entry of due) {
      const latest = await this.latestVersion(tenantId, entry.id);
      if (!latest) continue;
      await this.prisma.contentEntry.update({
        where: { id: entry.id },
        data: {
          status: ContentStatus.published,
          currentVersionId: latest.id,
          publishedAt: now,
          publishAt: null,
        },
      });
      await this.audit.write(tenantId, {
        actorRole: 'system',
        action: 'content.scheduled_published',
        entity: 'content_entry',
        entityId: entry.id,
        after: { version: latest.version },
      });
      published.push(entry.id);
    }
    // TODO: emit cache invalidation per flipped entry — docs/11.
    return { published: published.length, ids: published };
  }

  // ---------- media ----------
  async mediaSign(actor: Actor, tenantId: string, dto: MediaSignDto) {
    const upload = this.storage.createImageUpload(
      tenantId,
      'content',
      dto.contentType,
      dto.bytes ?? 1,
    );
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'content.media.signed',
      entity: 'content_media',
      entityId: upload.key,
      after: { key: upload.key, filename: dto.filename ?? null },
    });
    return upload;
  }

  // ---------- site config (editable key/value JSON) ----------
  async setSiteConfig(actor: Actor, tenantId: string, dto: SiteConfigDto) {
    const before = await this.prisma.siteConfig.findUnique({
      where: { tenantId_key: { tenantId, key: dto.key } },
    });
    const value = dto.value as Prisma.InputJsonValue;
    const saved = await this.prisma.siteConfig.upsert({
      where: { tenantId_key: { tenantId, key: dto.key } },
      create: { tenantId, key: dto.key, value, updatedById: actor.id },
      update: { value, updatedById: actor.id },
    });
    await this.audit.write(tenantId, {
      actorId: actor.id,
      actorRole: actor.roles.join(','),
      action: 'content.site_config.updated',
      entity: 'site_config',
      entityId: dto.key,
      before: before ? (before.value as Prisma.InputJsonValue) : undefined,
      after: { key: dto.key },
    });
    return saved;
  }

  getSiteConfig(tenantId: string, key?: string) {
    if (key) {
      return this.prisma.siteConfig.findUnique({ where: { tenantId_key: { tenantId, key } } });
    }
    return this.prisma.siteConfig.findMany({ where: { tenantId }, orderBy: { key: 'asc' } });
  }
}
