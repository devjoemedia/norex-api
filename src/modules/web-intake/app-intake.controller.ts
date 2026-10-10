import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { RATE_LIMITS } from '../../common/http/rate-limits';
import { deviceTypeFromClient } from '../../common/http/client-channel';
import { WebApplicationDto } from './dto/web-application.dto';
import { MOBILE_APP, WebIntakeService } from './web-intake.service';
import { TrackService } from './track.service';
import { TrackDto } from './web-intake.controller';

// Guest applications straight from the mobile app (no sign-in yet, docs/19). An app
// can't keep a secret, so there's no key: the API re-prices everything, and requests
// are rate-limited by the caller's own IP.
@Controller('app')
@Public()
@Throttle(RATE_LIMITS.appIntake)
export class AppIntakeController {
  constructor(
    private readonly intake: WebIntakeService,
    private readonly tracking: TrackService,
  ) {}

  @Post('applications')
  @HttpCode(200)
  submit(
    @TenantId() tenantId: string,
    @Body() dto: WebApplicationDto,
    @Headers('x-client-device') device?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.intake.submit(tenantId, dto, deviceTypeFromClient(device, userAgent), MOBILE_APP);
  }

  // Same lookup as the website's /track, for the app.
  @Post('track')
  @HttpCode(200)
  @Throttle(RATE_LIMITS.track)
  track(@TenantId() tenantId: string, @Body() dto: TrackDto) {
    return this.tracking.track(tenantId, dto.reference, dto.phone);
  }
}
