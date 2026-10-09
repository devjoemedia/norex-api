import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentProvider } from './payment-provider.interface';
import { SandboxProvider } from './sandbox.provider';

// Resolves a provider key to its implementation. Every known key maps to the sandbox
// until live integrations are certified (separately priced, docs/09). The tenant's
// provider_configs allow-list still gates which keys a tenant may actually use.
@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();
  private readonly known = ['sandbox', 'mtn_momo', 'wave', 'qmoney'];

  constructor() {
    for (const key of this.known) this.providers.set(key, new SandboxProvider(key));
  }

  get(key: string): PaymentProvider {
    const p = this.providers.get(key);
    if (!p) throw new BadRequestException(`Unsupported payment provider "${key}"`);
    return p;
  }

  isKnown(key: string): boolean {
    return this.providers.has(key);
  }
}
