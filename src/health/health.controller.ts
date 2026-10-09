import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckError, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';

// Render's health checks poll this; they must never be rate limited.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async () => {
        try {
          await this.prisma.$queryRaw`SELECT 1`;
          return { database: { status: 'up' } };
        } catch {
          throw new HealthCheckError('Database unavailable', { database: { status: 'down' } });
        }
      },
    ]);
  }
}
