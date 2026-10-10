import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecoveryController } from './recovery.controller';
import { RecoveryService } from './recovery.service';
import { CollectionsSchedulerService } from './collections-scheduler.service';

// Reminders and recovery cases (docs/24).
@Module({
  imports: [NotificationsModule],
  controllers: [RecoveryController],
  providers: [RecoveryService, CollectionsSchedulerService],
})
export class CollectionsModule {}
