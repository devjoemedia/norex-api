import { Module } from '@nestjs/common';
import { AdminDeviceUnitsController } from './admin-device-units.controller';
import { DeviceUnitsService } from './device-units.service';
import { ImeiService } from './imei.service';
import { StockTransfersService } from './stock-transfers.service';
import { AdminTransfersController } from './admin-transfers.controller';

@Module({
  controllers: [AdminDeviceUnitsController, AdminTransfersController],
  providers: [DeviceUnitsService, ImeiService, StockTransfersService],
  exports: [ImeiService],
})
export class DeviceUnitsModule {}
