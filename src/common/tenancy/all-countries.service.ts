import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { withTenant } from '../context/request-context';
import { ALL_TENANTS, TenantScopeValue } from '../decorators/tenant-scope.decorator';

export interface CountryTag {
  tenantId: string;
  countrySlug: string;
  country: string;
  countryName: string;
  currency: string;
}

type Tagged<T> = T extends object ? T & CountryTag : T;

// Runs a per-country read for each active country and merges the results. Totals
// stay per country (never summed or converted) because currencies differ (docs/15).
@Injectable()
export class AllCountriesService {
  constructor(private readonly prisma: PrismaService) {}

  countries() {
    return this.prisma.tenant.findMany({
      where: { isCountry: true, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, subdomain: true, country: true, name: true, currency: true },
    });
  }

  /** `{ stats, rows, ... }` endpoints: one stats block per country, rows tagged and merged. */
  async listing<R extends { rows: unknown[] }>(
    scope: TenantScopeValue,
    load: (tenantId: string) => Promise<R>,
  ) {
    if (scope !== ALL_TENANTS) return load(scope);
    const per = await this.each(load);
    return {
      allCountries: true as const,
      countries: per.map(({ tag, result }) => ({ ...tag, ...withoutRows(result) })),
      rows: per.flatMap(({ tag, result }) => result.rows.map((r) => tagRow(r, tag))),
    };
  }

  /** Plain-array endpoints: rows tagged with their country and concatenated. */
  async array<T>(scope: TenantScopeValue, load: (tenantId: string) => Promise<T[]>) {
    if (scope !== ALL_TENANTS) return load(scope);
    const per = await this.each(load);
    return per.flatMap(({ tag, result }) => result.map((r) => tagRow(r, tag)));
  }

  /** Whole-object endpoints (dashboard): one entry per country, side by side. */
  async perCountry<R extends object>(
    scope: TenantScopeValue,
    load: (tenantId: string) => Promise<R>,
  ) {
    if (scope !== ALL_TENANTS) return load(scope);
    const per = await this.each(load);
    return {
      allCountries: true as const,
      countries: per.map(({ tag, result }) => ({ ...tag, ...result })),
    };
  }

  private async each<R>(load: (tenantId: string) => Promise<R>) {
    const tenants = await this.countries();
    return Promise.all(
      tenants.map(async (t) => {
        const tag: CountryTag = {
          tenantId: t.id,
          countrySlug: t.subdomain,
          country: t.country,
          countryName: t.name,
          currency: t.currency,
        };
        // RLS: each country's read runs scoped to that country only.
        return { tag, result: await withTenant(t.id, () => load(t.id)) };
      }),
    );
  }
}

// A row's own currency (e.g. a payment's) wins over the country default.
function tagRow<T>(row: T, tag: CountryTag): Tagged<T> {
  if (!row || typeof row !== 'object') return row as Tagged<T>;
  return { ...tag, ...(row as object) } as Tagged<T>;
}

function withoutRows<R extends { rows: unknown[] }>(result: R): Omit<R, 'rows'> {
  const copy: Partial<R> = { ...result };
  delete copy.rows;
  return copy as Omit<R, 'rows'>;
}
