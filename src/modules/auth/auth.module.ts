import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { StaffAuthService } from './staff-auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { StaffInviteService } from './staff-invite.service';
import { MailService } from '../../common/mail/mail.service';

@Module({
  imports: [NotificationsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    StaffAuthService,
    OtpService,
    TokenService,
    StaffInviteService,
    MailService,
  ],
  exports: [TokenService, StaffInviteService],
})
export class AuthModule {}
