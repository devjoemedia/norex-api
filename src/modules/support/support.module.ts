import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

// Customer support tickets (docs/25).
@Module({
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class SupportModule {}
