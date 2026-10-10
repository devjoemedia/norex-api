import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { requestContext } from '../context/request-context';
import { resolveTenant } from '../tenancy/resolve-tenant';

// Resolves the country (tenant) for every request: full domain (tenant_domains) →
// subdomain → X-Tenant header; `X-Tenant: all` only sets a flag that AllTenantsGuard
// checks. Never trusts a tenant id from the request body.
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  // Small in-process caches. Real deployments back these with Redis.
  private static byHost = new Map<string, string | null>();
  private static bySub = new Map<string, string | null>();
  private static byHeader = new Map<string, string | null>();

  constructor(private readonly prisma: PrismaService) {}

  // Clears the caches after a country or domain changes (CountriesService).
  static invalidate(): void {
    TenantMiddleware.byHost.clear();
    TenantMiddleware.bySub.clear();
    TenantMiddleware.byHeader.clear();
  }

  async use(
    req: Request & {
      id?: string;
      tenantId?: string;
      tenantSubdomain?: string;
      allTenants?: boolean;
    },
    res: Response,
    next: NextFunction,
  ) {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.id = requestId;
    res.setHeader('x-request-id', requestId);

    const resolved = await resolveTenant(
      (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host,
      req.headers['x-tenant'] as string | undefined,
      {
        byHost: (host) => this.cached(TenantMiddleware.byHost, host, () => this.domainTenant(host)),
        bySubdomain: (sub) =>
          this.cached(TenantMiddleware.bySub, sub, () => this.activeTenant(sub)),
        byHeader: (slug) =>
          this.cached(TenantMiddleware.byHeader, slug, () => this.anyTenant(slug)),
      },
    );

    req.tenantId = resolved.tenantId;
    req.tenantSubdomain = resolved.subdomain;
    req.allTenants = resolved.allTenants;

    // Actor hints from internal callers are kept for audit trails only — never authz.
    const actorId = (req.headers['x-actor-id'] as string | undefined) || undefined;
    const actorRole = (req.headers['x-actor-role'] as string | undefined) || undefined;

    requestContext.run(
      {
        requestId,
        tenantId: resolved.tenantId,
        tenantSubdomain: resolved.subdomain,
        allTenants: resolved.allTenants,
        userId: actorId,
        roles: actorRole ? [actorRole] : undefined,
      },
      () => next(),
    );
  }

  private async cached(
    map: Map<string, string | null>,
    key: string,
    load: () => Promise<string | null>,
  ): Promise<string | undefined> {
    if (!map.has(key)) map.set(key, await load());
    return map.get(key) ?? undefined;
  }

  // Runs on every request, so these read only the columns they need: a new tenant
  // column that isn't in the database yet can't take the whole API down.
  // Staff (X-Tenant) can work in a country before it launches.
  private async anyTenant(subdomain: string): Promise<string | null> {
    const t = await this.prisma.tenant.findUnique({ where: { subdomain }, select: { id: true } });
    return t?.id ?? null;
  }

  private async activeTenant(subdomain: string): Promise<string | null> {
    const t = await this.prisma.tenant.findUnique({
      where: { subdomain },
      select: { id: true, active: true },
    });
    return t?.active ? t.id : null;
  }

  private async domainTenant(host: string): Promise<string | null> {
    const d = await this.prisma.tenantDomain.findUnique({
      where: { host },
      select: { tenantId: true, tenant: { select: { active: true } } },
    });
    return d?.tenant.active ? d.tenantId : null;
  }
}
