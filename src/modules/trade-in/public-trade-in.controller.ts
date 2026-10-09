import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TradeInService } from './trade-in.service';

// Anonymous, tenant-scoped read of the active condition options for the intake form.
@Controller('trade-in')
export class PublicTradeInController {
  constructor(private readonly tradeIn: TradeInService) {}

  @Public()
  @Get('condition-options')
  conditionOptions(@TenantId() tenantId: string) {
    return this.tradeIn.conditionOptions(tenantId);
  }
}
