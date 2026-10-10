import { formatAmount } from '../../common/tenancy/money-text';

// The agreement a customer signs at the counter, built from the application's frozen
// plan snapshot. The exact text and its hash are stored with the signature, so what
// was signed can always be shown again word for word.

export interface AgreementContext {
  country: string;
  reference: string;
  type: 'financing' | 'lease' | 'trade_in';
  customerName: string;
  customerPhone: string;
  device: string;
  currency: string;
  snapshot: Record<string, unknown>;
  frequency: 'monthly' | 'biweekly' | 'weekly';
}

const EVERY = { monthly: 'month', biweekly: 'two weeks', weekly: 'week' } as const;

export function agreementText(c: AgreementContext): string {
  const n = (k: string) => Number(c.snapshot[k] ?? 0);
  const money = (minor: number) => `${c.currency} ${formatAmount(minor, c.currency)}`;
  const months = n('months');
  const header = [
    `${c.country}: ${c.type === 'lease' ? 'lease' : 'installment'} agreement ${c.reference}`,
    `Customer: ${c.customerName}${c.customerPhone ? ` (${c.customerPhone})` : ''}`,
    `Device: ${c.device}`,
    '',
  ];

  if (c.type === 'lease') {
    return [
      ...header,
      `1. Norex leases the device to the customer for ${months} months at ${money(n('monthlyMinor'))} a month.`,
      '2. The device stays the property of Norex. The customer keeps it in good condition and returns it at the end of the lease, or upgrades as offered.',
      '3. Late payments may lead Norex to restrict the device until the account is brought up to date.',
      '4. Loss, theft or damage must be reported to Norex within 48 hours.',
      '5. The customer confirms the information in their application is true.',
    ].join('\n');
  }

  const periods = n('periods') || months;
  const per = n('periodMinor') || n('monthlyMinor');
  const finalPer = n('finalPeriodMinor') || n('finalMonthlyMinor') || per;
  return [
    ...header,
    `1. Price of the plan: ${money(n('totalPayableMinor'))} in total.`,
    `2. Paid today: a deposit of ${money(n('depositMinor'))}.`,
    `3. Then ${periods} payments of ${money(per)}, one every ${EVERY[c.frequency]}${
      finalPer !== per ? ` (the last one ${money(finalPer)})` : ''
    }, starting one ${EVERY[c.frequency]} from today.`,
    '4. The customer may pay early at any time, in full or in part, at no extra cost.',
    '5. If a payment is late, Norex will remind the customer and may restrict the device until the account is up to date. The device is unlocked again once payments are current.',
    '6. The device becomes the customer’s once every payment is made.',
    '7. Loss, theft or damage must be reported to Norex within 48 hours; payments remain due.',
    '8. The customer confirms the information in their application is true, and agrees to be contacted about this agreement by phone, SMS, WhatsApp or email.',
  ].join('\n');
}
