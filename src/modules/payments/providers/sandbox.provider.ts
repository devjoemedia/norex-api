import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  InitiateInput,
  InitiateResult,
  PaymentProvider,
  ProviderEvent,
} from './payment-provider.interface';

// Sandbox mobile-money provider. Signs/verifies webhooks with HMAC-SHA256 over the raw
// body — the same shape real MTN MoMo / Wave / QMoney callbacks use — so exactly-once,
// signature-rejection and amount-mismatch behaviour are all exercised without a live
// integration.
export class SandboxProvider implements PaymentProvider {
  readonly key: string;

  constructor(key = 'sandbox') {
    this.key = key;
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const providerRef = `SBX-${randomUUID()}`;
    return {
      providerRef,
      ussdCode: input.channel === 'ussd' ? `*180*4*${input.reference.slice(0, 6)}#` : undefined,
      handoffUrl:
        input.channel === 'app' ? `https://sandbox.momo.local/pay/${providerRef}` : undefined,
    };
  }

  // HMAC-SHA256(rawBody) compared in constant time.
  verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // Helper for tests / sandbox tooling to produce a valid signature.
  static sign(rawBody: string, secret: string): string {
    return createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  parseEvent(payload: unknown): ProviderEvent {
    const p = payload as Record<string, unknown>;
    const eventId = p.eventId;
    const providerRef = p.providerRef;
    const status = p.status;
    const amountMinor = p.amountMinor;
    const currency = p.currency;
    if (
      typeof eventId !== 'string' ||
      typeof providerRef !== 'string' ||
      (status !== 'succeeded' && status !== 'failed') ||
      typeof amountMinor !== 'number' ||
      typeof currency !== 'string'
    ) {
      throw new BadRequestException('Malformed provider event');
    }
    return { eventId, providerRef, status, amountMinor, currency };
  }

  async refund(): Promise<void> {
    // No-op in sandbox; a live provider would call its refund API here.
  }
}
