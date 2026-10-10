import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module';
import { RiskService } from './risk.service';

// Rule-based risk checks on applications (docs/26).
@Module({
  imports: [KycModule],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
