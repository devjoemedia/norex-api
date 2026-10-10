import { Body, Controller, Delete, Get, Headers, HttpCode, Ip, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { RATE_LIMITS } from '../../common/http/rate-limits';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { StaffAuthService } from './staff-auth.service';
import { TokenService } from './token.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshDto } from './dto/refresh.dto';
import { StaffLoginDto } from './dto/staff-login.dto';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  InviteTokenDto,
  SetPasswordDto,
} from './dto/staff-password.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly staff: StaffAuthService,
    private readonly tokens: TokenService,
  ) {}

  @Public()
  @Throttle(RATE_LIMITS.otp)
  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@TenantId() tenantId: string, @Body() dto: RequestOtpDto, @Ip() ip: string) {
    await this.auth.requestOtp(tenantId, dto.phone, ip);
    return { message: 'If the number is valid, a code has been sent.' };
  }

  @Public()
  @Throttle(RATE_LIMITS.otp)
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(
    @TenantId() tenantId: string,
    @Body() dto: VerifyOtpDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.auth.verifyOtp(tenantId, dto.phone, dto.code, { ip, userAgent });
  }

  @Public()
  @Throttle(RATE_LIMITS.tokenRefresh)
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @TenantId() tenantId: string,
    @Body() dto: RefreshDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.auth.refresh(tenantId, dto.refreshToken, { ip, userAgent });
  }

  @Public()
  @Throttle(RATE_LIMITS.staffSignIn)
  @Post('staff/login')
  @HttpCode(200)
  async staffLogin(@TenantId() tenantId: string, @Body() dto: StaffLoginDto) {
    return this.staff.login(tenantId, dto.email, dto.password);
  }

  @Public()
  @Throttle(RATE_LIMITS.staffSignIn)
  @Post('staff/2fa')
  @HttpCode(200)
  async staff2fa(
    @TenantId() tenantId: string,
    @Body() dto: Verify2faDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.staff.verify2fa(
      tenantId,
      dto.challengeId,
      { totp: dto.totp, recoveryCode: dto.recoveryCode },
      { ip, userAgent },
    );
  }

  // First sign-in with a password someone else chose: pick your own (docs/20).
  @Public()
  @Throttle(RATE_LIMITS.staffSignIn)
  @Post('staff/set-password')
  @HttpCode(200)
  setPassword(@TenantId() tenantId: string, @Body() dto: SetPasswordDto, @Ip() ip: string) {
    return this.staff.setPassword(tenantId, dto.challengeId, dto.password, { ip });
  }

  // Invite links: check the link, then choose a password and go on to two-factor.
  @Public()
  @Throttle(RATE_LIMITS.staffSignIn)
  @Post('staff/invite')
  @HttpCode(200)
  inspectInvite(@TenantId() tenantId: string, @Body() dto: InviteTokenDto) {
    return this.staff.inspectInvite(tenantId, dto.token);
  }

  @Public()
  @Throttle(RATE_LIMITS.staffSignIn)
  @Post('staff/invite/accept')
  @HttpCode(200)
  acceptInvite(@TenantId() tenantId: string, @Body() dto: AcceptInviteDto, @Ip() ip: string) {
    return this.staff.acceptInvite(tenantId, dto.token, dto.password, { ip });
  }

  @Throttle(RATE_LIMITS.staffSignIn)
  @Post('staff/password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Ip() ip: string,
  ) {
    await this.staff.changePassword(user, dto.currentPassword, dto.newPassword, { ip });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser) {
    if (user.sid) await this.auth.logout(user.sid, user.tenantId);
  }

  @Get('sessions')
  async sessions(@CurrentUser() user: AuthUser) {
    return this.tokens.list(user.id, user.tenantId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.tokens.revokeOwned(id, user.id, user.tenantId);
  }
}
