import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { KycModule } from '../kyc/kyc.module';
import { FulfilmentController } from './fulfilment.controller';
import { FulfilmentService } from './fulfilment.service';

@Module({
  imports: [ApplicationsModule, KycModule],
  controllers: [FulfilmentController],
  providers: [FulfilmentService],
  exports: [FulfilmentService],
})
export class FulfilmentModule {}
