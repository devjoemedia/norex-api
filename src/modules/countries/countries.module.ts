import { Module } from '@nestjs/common';
import { CountriesController, PublicCountriesController } from './countries.controller';
import { CountriesService } from './countries.service';

@Module({
  controllers: [CountriesController, PublicCountriesController],
  providers: [CountriesService],
})
export class CountriesModule {}
