import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { KycModule } from '../kyc/kyc.module';
import { DeviceUnitsModule } from '../device-units/device-units.module';
import { AdminOrdersController } from './admin-orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [CatalogModule, KycModule, DeviceUnitsModule],
  controllers: [AdminOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
