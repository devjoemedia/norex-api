import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface IdempotencyState {
  firstTime: boolean;
  resultRef: string | null;
}

// Retry-safe guard for mutating operations. `begin` claims the key; a repeat call
// returns the prior result reference so double-taps/retries don't double-process.
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async begin(tenantId: string, key: string, scope: string): Promise<IdempotencyState> {
    try {
      await this.prisma.idempotencyKey.create({ data: { tenantId, key, scope } });
      return { firstTime: true, resultRef: null };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.idempotencyKey.findUnique({
          where: { tenantId_key: { tenantId, key } },
        });
        return { firstTime: false, resultRef: existing?.resultRef ?? null };
      }
      throw e;
    }
  }

  async complete(tenantId: string, key: string, resultRef: string): Promise<void> {
    await this.prisma.idempotencyKey.updateMany({ where: { tenantId, key }, data: { resultRef } });
  }
}
