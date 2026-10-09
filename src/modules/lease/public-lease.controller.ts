import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { LeaseService } from './lease.service';
import { LeaseQuoteDto } from './dto/lease.dto';

// Anonymous, tenant-scoped lease pricing + agreement-terms reads.
@Controller('lease')
export class PublicLeaseController {
  constructor(private readonly lease: LeaseService) {}

  @Public()
  @Get('terms')
  terms(@TenantId() tenantId: string) {
    return this.lease.activeTermsTemplate(tenantId);
  }

  @Public()
  @Get(':deviceId/options')
  options(@TenantId() tenantId: string, @Param('deviceId', ParseUUIDPipe) deviceId: string) {
    return this.lease.options(tenantId, deviceId);
  }

  @Public()
  @Post('quote')
  quote(@TenantId() tenantId: string, @Body() dto: LeaseQuoteDto) {
    return this.lease.quote(tenantId, dto.deviceId, dto.months);
  }
}
