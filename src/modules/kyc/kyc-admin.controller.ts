import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { KycService } from './kyc.service';
import { ListProfilesDto, VerifyDto } from './dto/kyc.dto';

const REVIEW = [Role.Agent, Role.ApprovalsOfficer, Role.CountryManager] as const;

// Staff review — ID-number decrypt and document URLs are restricted and logged.
@Controller('kyc/profiles')
export class KycAdminController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @Roles(...REVIEW)
  list(@TenantId() tenantId: string, @Query() query: ListProfilesDto) {
    return this.kyc.listProfiles(tenantId, query);
  }

  @Get(':id')
  @Roles(...REVIEW)
  get(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Ip() ip: string,
    @Headers('x-request-id') requestId: string,
  ) {
    return this.kyc.getProfile(tenantId, actor, id, { ip, requestId });
  }

  @Get(':id/documents/:docId/url')
  @Roles(...REVIEW)
  docUrl(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Ip() ip: string,
    @Headers('x-request-id') requestId: string,
  ) {
    return this.kyc.staffDocUrl(tenantId, actor, id, docId, { ip, requestId });
  }

  @Post(':id/verify')
  @Roles(Role.ApprovalsOfficer, Role.CountryManager)
  @HttpCode(200)
  verify(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: VerifyDto,
    @Ip() ip: string,
    @Headers('x-request-id') requestId: string,
  ) {
    return this.kyc.verify(tenantId, actor, id, dto, { ip, requestId });
  }
}
