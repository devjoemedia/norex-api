import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { safeEqualText } from '../crypto/hash.util';

// Per-IP limits. Website intake calls all come from the website's server, so for those
// (and only when X-Web-Key is valid) the applicant's IP it forwards is the key instead.
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    super(options, storage, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const clientIp = req.headers?.['x-client-ip'];
    if (typeof clientIp === 'string' && clientIp && this.hasWebKey(req)) {
      return `web:${clientIp.slice(0, 64)}`;
    }
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  private hasWebKey(req: Record<string, any>): boolean {
    const expected = this.config.get<string>('WEB_INTAKE_KEY');
    const given = req.headers?.['x-web-key'];
    return !!expected && typeof given === 'string' && safeEqualText(given, expected);
  }
}
