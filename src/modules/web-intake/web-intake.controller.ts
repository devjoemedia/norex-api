import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { deviceTypeFromUserAgent } from '../../common/http/client-channel';
import { Throttle } from '@nestjs/throttler';
import { RATE_LIMITS } from '../../common/http/rate-limits';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { WebApplicationDto } from './dto/web-application.dto';
import { WebOrderDto } from '../orders/dto/order.dto';
import { WebIntakeGuard } from './web-intake.guard';
import { WebIntakeService } from './web-intake.service';

// Guest applications and cart orders from the website (no customer sign-in yet, docs/16). Rate limits
// count the applicant's IP that the website forwards (see AppThrottlerGuard).
@Controller('web')
@Public()
@Throttle(RATE_LIMITS.webIntake)
@UseGuards(WebIntakeGuard)
export class WebIntakeController {
  constructor(private readonly intake: WebIntakeService) {}

  @Post('applications')
  @HttpCode(200)
  submit(
    @TenantId() tenantId: string,
    @Body() dto: WebApplicationDto,
    @Headers('x-client-ua') clientUa?: string,
  ) {
    // The website forwards the applicant's browser User-Agent (docs/19).
    return this.intake.submit(tenantId, dto, deviceTypeFromUserAgent(clientUa));
  }

  // Cart checkout: paid in full with cash on collection (docs/18).
  @Post('orders')
  @HttpCode(200)
  order(
    @TenantId() tenantId: string,
    @Body() dto: WebOrderDto,
    @Headers('x-client-ua') clientUa?: string,
  ) {
    return this.intake.submitOrder(tenantId, dto, deviceTypeFromUserAgent(clientUa));
  }
}
