import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { ContentService } from './content.service';

// Anonymous, tenant-scoped, published-only reads for the SSR front-end's typed content
// seams. Cache-Control lets a CDN cache per (tenant,type,slug,locale); publish/unpublish
// should invalidate the surrogate key. TODO: ETag + surrogate-key invalidation (docs/11 —
// no cache layer wired yet).
@Controller('content')
export class PublicContentController {
  constructor(private readonly content: ContentService) {}

  @Public()
  @Get(':type')
  @Header('Cache-Control', 'public, max-age=60')
  list(
    @TenantId() tenantId: string,
    @Param('type') type: string,
    @Query('locale') locale?: string,
    @Query('slug') slug?: string,
  ) {
    return this.content.publicList(tenantId, type, { locale, slug });
  }

  @Public()
  @Get(':type/:slug')
  @Header('Cache-Control', 'public, max-age=60')
  detail(
    @TenantId() tenantId: string,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ) {
    return this.content.publicDetail(tenantId, type, slug, locale);
  }
}
