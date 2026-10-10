import { Module } from '@nestjs/common';
import { RiskModule } from '../risk/risk.module';
import { CatalogModule } from '../catalog/catalog.module';
import { KycModule } from '../kyc/kyc.module';
import { FinancingModule } from '../financing/financing.module';
import { LeaseModule } from '../lease/lease.module';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

@Module({
  imports: [
    CatalogModule,
    KycModule,
    FinancingModule,
    LeaseModule,
    PaymentsModule,
    NotificationsModule,
    RiskModule,
  ],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
