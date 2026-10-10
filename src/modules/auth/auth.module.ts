import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { StaffAuthService } from './staff-auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { StaffInviteService } from './staff-invite.service';
import { MailModule } from '../../common/mail/mail.module';

@Module({
  imports: [NotificationsModule, MailModule],
  controllers: [AuthController],
  providers: [AuthService, StaffAuthService, OtpService, TokenService, StaffInviteService],
  exports: [TokenService, StaffInviteService],
})
export class AuthModule {}
