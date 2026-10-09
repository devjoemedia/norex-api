import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { FinancingService } from './financing.service';
import { QuoteDto } from './dto/finance.dto';

// Anonymous, tenant-scoped BNPL pricing reads.
@Controller('finance')
export class PublicFinancingController {
  constructor(private readonly financing: FinancingService) {}

  @Public()
  @Get('plans/:deviceId/options')
  options(@TenantId() tenantId: string, @Param('deviceId', ParseUUIDPipe) deviceId: string) {
    return this.financing.options(tenantId, deviceId);
  }

  @Public()
  @Get('quote')
  quote(@TenantId() tenantId: string, @Query() q: QuoteDto) {
    return this.financing.quote(tenantId, q.deviceId, q.months, q.upfrontMinor);
  }
}
