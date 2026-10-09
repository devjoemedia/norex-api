import { Module } from '@nestjs/common';
import { PublicCatalogController } from './public-catalog.controller';
import { AdminCatalogController } from './admin-catalog.controller';
import { CatalogService } from './catalog.service';
import { MediaService } from './media.service';

@Module({
  controllers: [PublicCatalogController, AdminCatalogController],
  providers: [CatalogService, MediaService],
  exports: [CatalogService],
})
export class CatalogModule {}
