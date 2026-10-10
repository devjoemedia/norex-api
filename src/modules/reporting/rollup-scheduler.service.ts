import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant } from '../../common/context/request-context';
import { PrismaService } from '../../database/prisma.service';
import { ReportingService } from './reporting.service';
import { recordJobRun } from '../../common/jobs/job-status';

const DAY = 86_400_000;
const BACKFILL_DAYS = 90;
const HOURLY = 60 * 60 * 1000;

// Keeps report rollups filled (docs/13). In-process until a job queue exists: on boot
// it backfills the last 90 days, then refreshes today + yesterday every hour. Each
// country runs in its own RLS scope. Off in tests; ROLLUPS_ENABLED=false disables it.
@Injectable()
export class RollupSchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Rollups');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reporting: ReportingService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('NODE_ENV') !== 'test' && process.env.ROLLUPS_ENABLED !== 'false';
    if (!enabled) return;
    // Don't hold up boot: backfill in the background.
    setTimeout(() => void this.run(BACKFILL_DAYS), 5_000).unref();
    this.timer = setInterval(() => void this.run(2), HOURLY);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Recompute `days` days (ending today) for every country. Returns days refreshed. */
  async run(days: number, tenantIds?: string[]): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const started = Date.now();
    let done = 0;
    try {
      const tenants = tenantIds
        ? tenantIds
        : (
            await this.prisma.tenant.findMany({ where: { isCountry: true }, select: { id: true } })
          ).map((t) => t.id);
      for (const tenantId of tenants) {
        await withTenant(tenantId, async () => {
          for (let i = days - 1; i >= 0; i--) {
            await this.reporting.refreshRollups(tenantId, new Date(Date.now() - i * DAY));
            done++;
          }
        });
      }
      this.log.log(`Refreshed ${done} country-days of report rollups in ${Date.now() - started}ms`);
      recordJobRun('rollups', true, `${done} country-days`);
    } catch (e) {
      recordJobRun('rollups', false, (e as Error).message.slice(0, 120));
      this.log.error(`Rollup refresh failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return done;
  }
}
