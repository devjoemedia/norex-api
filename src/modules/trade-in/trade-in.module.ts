import { Module } from '@nestjs/common';
import { PublicTradeInController } from './public-trade-in.controller';
import { TradeInController } from './trade-in.controller';
import { AdminTradeInController } from './admin-trade-in.controller';
import { TradeInService } from './trade-in.service';

@Module({
  imports: [],
  controllers: [PublicTradeInController, TradeInController, AdminTradeInController],
  providers: [TradeInService],
  exports: [TradeInService],
})
export class TradeInModule {}
