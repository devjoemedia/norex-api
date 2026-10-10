import { Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CatalogModule } from '../catalog/catalog.module';
import { KycModule } from '../kyc/kyc.module';
import { DeviceUnitsModule } from '../device-units/device-units.module';
import { AdminOrdersController } from './admin-orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [CatalogModule, KycModule, DeviceUnitsModule, NotificationsModule, PayoutsModule],
  controllers: [AdminOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
