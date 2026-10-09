import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Seam for the SMS channel of the Notifications module (docs/10). In dev it logs
// the message; production swaps in a per-tenant provider (MoMo/SMS gateway).
@Injectable()
export class SmsService {
  private readonly logger = new Logger('SMS');

  constructor(private readonly config: ConfigService) {}

  async send(phone: string, message: string): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      // TODO: dispatch via the configured provider (docs/10-notifications.md).
      return;
    }
    this.logger.log(`SMS -> ${phone}: ${message}`);
  }
}
