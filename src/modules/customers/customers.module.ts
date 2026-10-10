import { Module } from '@nestjs/common';
import { DeviceUnitsModule } from '../device-units/device-units.module';
import { AdminCustomersController } from './admin-customers.controller';
import { CustomersService } from './customers.service';

// Global search and the customer 360° view (docs/21).
@Module({
  imports: [DeviceUnitsModule],
  controllers: [AdminCustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
