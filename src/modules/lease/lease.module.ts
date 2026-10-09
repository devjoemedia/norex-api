import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { PublicLeaseController } from './public-lease.controller';
import { LeaseController } from './lease.controller';
import { AdminLeaseController } from './admin-lease.controller';
import { LeaseService } from './lease.service';

@Module({
  imports: [CatalogModule],
  controllers: [PublicLeaseController, LeaseController, AdminLeaseController],
  providers: [LeaseService],
  exports: [LeaseService],
})
export class LeaseModule {}
