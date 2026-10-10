import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { FinancingService } from './financing.service';
import { QuoteDto } from './dto/finance.dto';

// Anonymous, tenant-scoped BNPL pricing reads.
@Controller('finance')
export class PublicFinancingController {
  constructor(private readonly financing: FinancingService) {}

  // ?deviceIds=a,b,c (max 200): cheapest monthly per device, for catalog cards.
  @Public()
  @Get('from')
  from(@TenantId() tenantId: string, @Query('deviceIds') deviceIds?: string) {
    const ids = [...new Set((deviceIds ?? '').split(',').map((s) => s.trim()))]
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
      .slice(0, 200);
    return this.financing.fromQuotes(tenantId, ids);
  }

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
