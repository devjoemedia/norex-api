import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { CatalogService } from './catalog.service';
import { PublicListDto } from './dto/device.dto';

// Anonymous, tenant-scoped reads — published + in-stock devices only.
@Controller('catalog')
export class PublicCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @Get('devices')
  list(@TenantId() tenantId: string, @Query() q: PublicListDto) {
    return this.catalog.publicList(tenantId, q);
  }

  @Public()
  @Get('trade-lease')
  tradeLease(@TenantId() tenantId: string, @Query() q: PublicListDto) {
    return this.catalog.tradeLease(tenantId, q);
  }

  @Public()
  @Get('facets')
  facets(@TenantId() tenantId: string) {
    return this.catalog.facets(tenantId);
  }

  @Public()
  @Get('devices/:slug')
  detail(@TenantId() tenantId: string, @Param('slug') slug: string) {
    return this.catalog.publicDetail(tenantId, slug);
  }
}
