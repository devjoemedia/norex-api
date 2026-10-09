import { InternalServerErrorException } from '@nestjs/common';

// Every amount is in its country's currency (docs/15). There is no default currency:
// a missing tenant here is a bug, not a reason to guess GMD or USD.
export function currencyOf(tenant: { currency: string } | null | undefined): string {
  if (!tenant?.currency) throw new InternalServerErrorException('Tenant currency not found');
  return tenant.currency;
}
