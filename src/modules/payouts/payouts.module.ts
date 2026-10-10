import { Module } from '@nestjs/common';
import { AdminPayoutsController } from './admin-payouts.controller';
import { PayoutsService } from './payouts.service';

// Agent commissions and partner outlet fees (docs/23).
@Module({
  controllers: [AdminPayoutsController],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
