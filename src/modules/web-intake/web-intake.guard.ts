import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { safeEqualText } from '../../common/crypto/hash.util';

// Server-to-server only: the website's server holds WEB_INTAKE_KEY, never the browser.
@Injectable()
export class WebIntakeGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.get<string>('WEB_INTAKE_KEY');
    const given = ctx.switchToHttp().getRequest().headers['x-web-key'];
    if (!expected || typeof given !== 'string' || !safeEqualText(given, expected)) {
      throw new UnauthorizedException('Invalid web key');
    }
    return true;
  }
}
