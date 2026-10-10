import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { KycModule } from '../kyc/kyc.module';

// Read-only list endpoints for the admin portal (PrismaService is global).
@Module({
  imports: [KycModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
