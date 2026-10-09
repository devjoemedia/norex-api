import { Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller';
import { AdminReportingController } from './admin-reporting.controller';
import { DashboardController } from './dashboard.controller';
import { ReportingService } from './reporting.service';
import { DashboardService } from './dashboard.service';
import { RollupSchedulerService } from './rollup-scheduler.service';

// PrismaService, AuditService and StorageService are provided by Global modules, so
// no imports are needed here (mirrors financing/lease).
@Module({
  imports: [],
  controllers: [ReportingController, AdminReportingController, DashboardController],
  providers: [ReportingService, DashboardService, RollupSchedulerService],
  exports: [ReportingService],
})
export class ReportingModule {}
