import { Module } from '@nestjs/common';
import { PublicBranchesController } from './public-branches.controller';
import { AdminBranchesController } from './admin-branches.controller';
import { BranchesService } from './branches.service';

@Module({
  controllers: [PublicBranchesController, AdminBranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
