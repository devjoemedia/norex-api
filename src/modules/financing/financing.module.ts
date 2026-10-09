import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { PublicFinancingController } from './public-financing.controller';
import { AdminFinancingController } from './admin-financing.controller';
import { FinancingService } from './financing.service';

@Module({
  imports: [CatalogModule],
  controllers: [PublicFinancingController, AdminFinancingController],
  providers: [FinancingService],
  exports: [FinancingService],
})
export class FinancingModule {}
