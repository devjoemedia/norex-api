import { Global, Module } from '@nestjs/common';
import { AllCountriesService } from './all-countries.service';

@Global()
@Module({
  providers: [AllCountriesService],
  exports: [AllCountriesService],
})
export class TenancyModule {}
