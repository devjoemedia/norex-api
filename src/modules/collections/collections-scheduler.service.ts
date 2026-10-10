import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant } from '../../common/context/request-context';
import { PrismaService } from '../../database/prisma.service';
import { RecoveryService } from './recovery.service';
import { recordJobRun } from '../../common/jobs/job-status';

const HOURLY = 60 * 60 * 1000;

// Runs collections every hour for every country (reminders, overdue flags, recovery
// cases), in-process like the report rollups until a job queue exists. Off in
// tests; COLLECTIONS_ENABLED=false disables it.
@Injectable()
export class CollectionsSchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Collections');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recovery: RecoveryService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('NODE_ENV') !== 'test' && process.env.COLLECTIONS_ENABLED !== 'false';
    if (!enabled) return;
    setTimeout(() => void this.run(), 20_000).unref();
    this.timer = setInterval(() => void this.run(), HOURLY);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.prisma.tenant.findMany({
        where: { isCountry: true },
        select: { id: true },
      });
      for (const t of tenants) {
        await withTenant(t.id, () => this.recovery.runFor(t.id));
      }
      recordJobRun('collections', true, `${tenants.length} countries`);
    } catch (e) {
      recordJobRun('collections', false, (e as Error).message.slice(0, 120));
      this.log.warn(`collections run failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
