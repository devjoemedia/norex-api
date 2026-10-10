import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

// Resend email, shared by staff invites (auth) and customer notifications.
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
