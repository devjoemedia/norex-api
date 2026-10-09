import { Module } from '@nestjs/common';
import { PublicContentController } from './public-content.controller';
import { AdminContentController } from './admin-content.controller';
import { ContentService } from './content.service';

@Module({
  imports: [],
  controllers: [PublicContentController, AdminContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
