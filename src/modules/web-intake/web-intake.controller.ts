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
import { TrackService } from './track.service';
import { IsString, Matches } from 'class-validator';

export class TrackDto {
  @IsString()
  @Matches(/^(BNP|LSE|TRD|ORD)-[A-Z0-9]{6}$/i, { message: 'Enter a reference like BNP-A1B2C3' })
  reference!: string;

  @IsString()
  @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'Enter the phone number you used' })
  phone!: string;
}

// Guest applications and cart orders from the website (no customer sign-in yet, docs/16). Rate limits
// count the applicant's IP that the website forwards (see AppThrottlerGuard).
@Controller('web')
@Public()
@Throttle(RATE_LIMITS.webIntake)
@UseGuards(WebIntakeGuard)
export class WebIntakeController {
  constructor(
    private readonly intake: WebIntakeService,
    private readonly tracking: TrackService,
  ) {}

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

  // /track on the website: reference + the phone used on it (docs/16).
  @Post('track')
  @HttpCode(200)
  @Throttle(RATE_LIMITS.track)
  track(@TenantId() tenantId: string, @Body() dto: TrackDto) {
    return this.tracking.track(tenantId, dto.reference, dto.phone);
  }
}
