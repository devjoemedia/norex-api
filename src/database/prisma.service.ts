import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { getContext, requestContext } from '../common/context/request-context';
import { findCurrencyMismatch } from '../common/tenancy/currency-guard';
import { rlsScope, scopeStatement } from './rls-scope';

type TxFn<T> = (tx: Prisma.TransactionClient) => Promise<T>;
type TxOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};
// The extended client's batch API, loosely typed (the extension's own types are huge).
interface BatchClient {
  $transaction(queries: unknown[], options?: TxOptions): Promise<unknown[]>;
  $executeRaw: PrismaClient['$executeRaw'];
}

// Prisma client that scopes every query to the request's country for Postgres RLS
// (prisma/rls.sql, docs/15). Each standalone query runs as a tiny transaction that
// first sets app.tenant_id; interactive transactions set it once at the start.
// The injected instance is a proxy over an extended client, so services keep using
// `this.prisma.x` and `this.prisma.$transaction(...)` unchanged.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');
  // Tenant id -> currency. Safe to cache: a country's currency is locked once it has
  // priced rows (CountriesService), and a change calls invalidateCurrencies().
  private static currencies = new Map<string, string | null>();

  static invalidateCurrencies(): void {
    PrismaService.currencies.clear();
  }

  constructor() {
    super();
    // Refuse any money row whose currency isn't its country's (docs/15).
    this.$use(async (params, next) => {
      const problem = await findCurrencyMismatch(
        params,
        (tenantId) => this.tenantCurrency(tenantId),
        (model, where) => this.rowTenant(model, where),
      );
      if (problem) throw new BadRequestException(problem);
      return next(params);
    });

    // The un-proxied client: the hooks and the proxy below must call it, not the proxy.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const base = this;
    const scoped = this.$extends({
      query: {
        async $allOperations({ args, query }) {
          const ctx = getContext();
          const scope = rlsScope(ctx);
          // Inside a batch transaction the scope was set by its first statement.
          if (!scope || ctx?.inTransaction) return query(args);
          const [, result] = await base.$transaction([
            scopeStatement(base.$executeRaw.bind(base), scope),
            query(args),
          ]);
          return result;
        },
      },
    });

    const transaction = (arg: unknown, options?: TxOptions) =>
      typeof arg === 'function'
        ? base.scopedInteractive(arg as TxFn<unknown>, options)
        : base.scopedBatch(scoped as unknown as BatchClient, arg as unknown[], options);

    return new Proxy(scoped, {
      get(target, prop, receiver) {
        if (prop === '$transaction') return transaction;
        if (prop in target) return Reflect.get(target, prop, receiver);
        const own = Reflect.get(base, prop) as unknown;
        return typeof own === 'function' ? (own as () => unknown).bind(base) : own;
      },
    }) as unknown as PrismaService;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
    await this.checkRls();
  }

  // RLS is silently skipped for superusers / BYPASSRLS roles and for tables it was
  // never applied to, so say so loudly at boot (prisma/roles.sql, prisma/rls.sql).
  private async checkRls(): Promise<void> {
    const [role] = await this.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    const [tables] = await this.$queryRaw<Array<{ total: bigint; protected: bigint }>>`
      SELECT count(*) AS total, count(*) FILTER (WHERE c.relrowsecurity) AS protected
        FROM information_schema.columns col
        JOIN pg_class c ON c.relname = col.table_name AND c.relkind = 'r'
       WHERE col.table_schema = 'public' AND col.column_name = 'tenantId'
         AND col.table_name <> 'tenant_domains'`;
    if (role?.rolsuper || role?.rolbypassrls) {
      this.logger.warn(
        'Connected as a superuser/BYPASSRLS role: row-level security is NOT enforced. Use the norex_app role (prisma/roles.sql).',
      );
    } else if (tables && tables.protected < tables.total) {
      this.logger.warn(
        `Row-level security is off on ${tables.total - tables.protected} of ${tables.total} tenant tables. Run npm run db:rls.`,
      );
    } else {
      this.logger.log(`Row-level security enforced on ${tables?.total ?? 0} tenant tables`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  // Runs `fn` inside a transaction scoped to one tenant, whatever the request is.
  async runInTenantContext<T>(tenantId: string, fn: TxFn<T>): Promise<T> {
    return requestContext.run(
      {
        ...(getContext() ?? { requestId: 'internal' }),
        tenantId,
        allTenants: false,
        system: false,
      },
      () => this.scopedInteractive(fn),
    );
  }

  // The base client's transaction has no query hook, so its queries all run on the
  // transaction's connection after the scope is set.
  private scopedInteractive<T>(fn: TxFn<T>, options?: TxOptions): Promise<T> {
    const scope = rlsScope(getContext());
    return this.$transaction(async (tx) => {
      if (scope) await scopeStatement(tx.$executeRaw.bind(tx), scope);
      return fn(tx);
    }, options);
  }

  private scopedBatch(scoped: BatchClient, queries: unknown[], options?: TxOptions) {
    const ctx = getContext();
    const scope = rlsScope(ctx);
    if (!scope) return scoped.$transaction(queries, options);
    return requestContext.run(
      { ...(ctx ?? { requestId: 'internal' }), inTransaction: true },
      async () => {
        const [, ...results] = await scoped.$transaction(
          [scopeStatement(scoped.$executeRaw.bind(scoped), scope), ...queries],
          options,
        );
        return results;
      },
    );
  }

  private async tenantCurrency(tenantId: string): Promise<string | null> {
    const cached = PrismaService.currencies.get(tenantId);
    if (cached !== undefined) return cached;
    // tenants has no RLS, so the base client can read it outside any scope.
    const t = await this.tenant.findUnique({ where: { id: tenantId }, select: { currency: true } });
    const currency = t?.currency ?? null;
    PrismaService.currencies.set(tenantId, currency);
    return currency;
  }

  // Row lookup for the currency guard, under the same RLS scope as the request.
  private async rowTenant(model: string, where: unknown): Promise<string | null> {
    type FindUnique = (args: object) => Prisma.PrismaPromise<{ tenantId: string } | null>;
    const key = model.charAt(0).toLowerCase() + model.slice(1);
    const delegate = (this as unknown as Record<string, { findUnique?: FindUnique } | undefined>)[
      key
    ];
    if (!delegate?.findUnique) return null;
    const scope = rlsScope(getContext());
    const lookup = delegate.findUnique({ where, select: { tenantId: true } });
    const row = scope
      ? (await this.$transaction([scopeStatement(this.$executeRaw.bind(this), scope), lookup]))[1]
      : await lookup;
    return row?.tenantId ?? null;
  }
}
