import { Body, Controller, Get, Headers, Ip, Param, Post, Put } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { KycService } from './kyc.service';
import { ConfirmDocDto, GuarantorDto, KycProfileDto, UploadDocDto } from './dto/kyc.dto';

// A customer manages only their own KYC (owner-scoped by the token subject).
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get('id-types')
  @Roles(Role.Customer, Role.Agent)
  idTypes(@TenantId() tenantId: string) {
    return this.kyc.getIdTypes(tenantId);
  }

  @Get('me')
  @Roles(Role.Customer)
  me(@TenantId() tenantId: string, @CurrentUser() user: AuthUser) {
    return this.kyc.getMe(tenantId, user.id);
  }

  @Put('me')
  @Roles(Role.Customer)
  putMe(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Body() dto: KycProfileDto) {
    return this.kyc.putMe(tenantId, user.id, dto);
  }

  @Put('me/guarantor')
  @Roles(Role.Customer)
  putGuarantor(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: GuarantorDto,
  ) {
    return this.kyc.putGuarantor(tenantId, user.id, dto);
  }

  @Post('me/documents/upload-url')
  @Roles(Role.Customer)
  uploadUrl(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadDocDto,
  ) {
    return this.kyc.docUploadUrl(tenantId, user.id, dto);
  }

  @Post('me/documents')
  @Roles(Role.Customer)
  confirmDoc(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ConfirmDocDto,
    @Ip() ip: string,
    @Headers('x-request-id') requestId: string,
  ) {
    return this.kyc.confirmDoc(tenantId, user.id, dto, user, { ip, requestId });
  }

  @Get('me/documents/:id/url')
  @Roles(Role.Customer)
  myDocUrl(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Ip() ip: string,
    @Headers('x-request-id') requestId: string,
  ) {
    return this.kyc.myDocUrl(tenantId, user, id, { ip, requestId });
  }
}
