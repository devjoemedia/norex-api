import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RATE_LIMITS } from '../../common/http/rate-limits';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { WebApplicationDto } from './dto/web-application.dto';
import { WebIntakeGuard } from './web-intake.guard';
import { WebIntakeService } from './web-intake.service';

// Guest applications from the website (no customer sign-in yet, docs/16). Rate limits
// count the applicant's IP that the website forwards (see AppThrottlerGuard).
@Controller('web')
@Public()
@Throttle(RATE_LIMITS.webIntake)
@UseGuards(WebIntakeGuard)
export class WebIntakeController {
  constructor(private readonly intake: WebIntakeService) {}

  @Post('applications')
  @HttpCode(200)
  submit(@TenantId() tenantId: string, @Body() dto: WebApplicationDto) {
    return this.intake.submit(tenantId, dto);
  }
}
