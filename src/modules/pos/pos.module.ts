import { Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { ApplicationsModule } from '../applications/applications.module';
import { PaymentsModule } from '../payments/payments.module';
import { DeviceUnitsModule } from '../device-units/device-units.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { AgreementsController } from './agreements.controller';

// The in-store sale at an outlet (docs/21).
@Module({
  imports: [ApplicationsModule, PaymentsModule, DeviceUnitsModule, PayoutsModule],
  controllers: [PosController, AgreementsController],
  providers: [PosService],
})
export class PosModule {}
