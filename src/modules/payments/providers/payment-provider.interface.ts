// A mobile-money provider behind a uniform interface (docs/09). Live provider
// certification is a separately-priced engagement; the sandbox implementation lets the
// full initiate -> webhook -> ledger flow run end to end in dev and tests.

export interface InitiateInput {
  amountMinor: number;
  currency: string;
  reference: string; // our payment id
  channel: 'app' | 'ussd';
  phone?: string;
}

export interface InitiateResult {
  providerRef: string;
  ussdCode?: string;
  handoffUrl?: string;
}

export interface ProviderEvent {
  eventId: string;
  providerRef: string;
  status: 'succeeded' | 'failed';
  amountMinor: number;
  currency: string;
}

export interface PaymentProvider {
  readonly key: string;
  initiate(input: InitiateInput): Promise<InitiateResult>;
  // Verifies the raw request body against the signature header using the tenant's
  // per-provider webhook secret. Returns false on any mismatch (never throws).
  verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean;
  parseEvent(payload: unknown): ProviderEvent;
  refund(providerRef: string, amountMinor: number): Promise<void>;
}
