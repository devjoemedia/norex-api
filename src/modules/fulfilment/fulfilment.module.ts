import { Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { ApplicationsModule } from '../applications/applications.module';
import { KycModule } from '../kyc/kyc.module';
import { DeviceUnitsModule } from '../device-units/device-units.module';
import { FulfilmentController } from './fulfilment.controller';
import { FulfilmentService } from './fulfilment.service';

@Module({
  imports: [ApplicationsModule, KycModule, DeviceUnitsModule, PayoutsModule],
  controllers: [FulfilmentController],
  providers: [FulfilmentService],
  exports: [FulfilmentService],
})
export class FulfilmentModule {}
