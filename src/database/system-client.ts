import { PrismaClient } from '@prisma/client';

// For trusted scripts (seed, bootstrap, backfills, checks): every query runs with
// RLS open to all countries (`app.system = on`, prisma/rls.sql). Never use it in
// request handling — the API scopes queries per country (PrismaService).
export function systemPrisma(): PrismaClient {
  const base = new PrismaClient();
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('app.system', 'on', true)`,
          query(args),
        ]);
        return result;
      },
    },
  }) as unknown as PrismaClient;
}
