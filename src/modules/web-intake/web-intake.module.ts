import { Module } from '@nestjs/common';
import { RiskModule } from '../risk/risk.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CatalogModule } from '../catalog/catalog.module';
import { KycModule } from '../kyc/kyc.module';
import { FinancingModule } from '../financing/financing.module';
import { LeaseModule } from '../lease/lease.module';
import { OrdersModule } from '../orders/orders.module';
import { WebIntakeController } from './web-intake.controller';
import { AppIntakeController } from './app-intake.controller';
import { WebIntakeService } from './web-intake.service';
import { TrackService } from './track.service';

@Module({
  imports: [
    CatalogModule,
    KycModule,
    FinancingModule,
    LeaseModule,
    OrdersModule,
    NotificationsModule,
    RiskModule,
  ],
  controllers: [WebIntakeController, AppIntakeController],
  providers: [WebIntakeService, TrackService],
})
export class WebIntakeModule {}
