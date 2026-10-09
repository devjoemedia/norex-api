import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycAdminController } from './kyc-admin.controller';
import { KycService } from './kyc.service';

@Module({
  controllers: [KycController, KycAdminController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
