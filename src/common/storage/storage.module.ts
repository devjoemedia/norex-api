import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

// Global so any feature module can inject StorageService without importing a module.
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
