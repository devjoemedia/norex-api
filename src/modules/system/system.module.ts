import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemHealthService } from './system-health.service';

// Integration and background job health (docs/26).
@Module({
  controllers: [SystemController],
  providers: [SystemHealthService],
})
export class SystemModule {}
