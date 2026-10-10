import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { KycModule } from '../kyc/kyc.module';
import { FinancingModule } from '../financing/financing.module';
import { LeaseModule } from '../lease/lease.module';
import { OrdersModule } from '../orders/orders.module';
import { WebIntakeController } from './web-intake.controller';
import { AppIntakeController } from './app-intake.controller';
import { WebIntakeService } from './web-intake.service';

@Module({
  imports: [CatalogModule, KycModule, FinancingModule, LeaseModule, OrdersModule],
  controllers: [WebIntakeController, AppIntakeController],
  providers: [WebIntakeService],
})
export class WebIntakeModule {}
