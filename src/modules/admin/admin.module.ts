import { Module } from '@nestjs/common';
import { RiskModule } from '../risk/risk.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { KycModule } from '../kyc/kyc.module';

// Read-only list endpoints for the admin portal (PrismaService is global).
@Module({
  imports: [KycModule, AuthModule, NotificationsModule, RiskModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
