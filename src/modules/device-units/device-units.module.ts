import { Module } from '@nestjs/common';
import { AdminDeviceUnitsController } from './admin-device-units.controller';
import { DeviceUnitsService } from './device-units.service';
import { ImeiService } from './imei.service';

@Module({
  controllers: [AdminDeviceUnitsController],
  providers: [DeviceUnitsService, ImeiService],
  exports: [ImeiService],
})
export class DeviceUnitsModule {}
