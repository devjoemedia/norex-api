import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

// Read-only list endpoints for the admin portal (PrismaService is global).
@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
