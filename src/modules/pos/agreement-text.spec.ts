import { agreementText } from './agreement-text';

const base = {
  country: 'Norex Gambia',
  reference: 'BNP-WKLY22',
  customerName: 'Awa Jallow',
  customerPhone: '+2207711442',
  device: 'iPhone 17 Pro 512GB',
  currency: 'GMD',
};

describe('agreementText', () => {
  it('spells out a weekly installment plan from the snapshot', () => {
    const text = agreementText({
      ...base,
      type: 'financing',
      frequency: 'weekly',
      snapshot: {
        months: 6,
        depositMinor: 2100000,
        totalPayableMinor: 11865000,
        periods: 26,
        periodMinor: 375576,
        finalPeriodMinor: 375600,
      },
    });
    expect(text).toContain('installment agreement BNP-WKLY22');
    expect(text).toContain('a deposit of GMD 21,000.00');
    expect(text).toContain(
      '26 payments of GMD 3,755.76, one every week (the last one GMD 3,756.00)',
    );
  });

  it('describes a lease', () => {
    const text = agreementText({
      ...base,
      type: 'lease',
      frequency: 'monthly',
      snapshot: { months: 12, monthlyMinor: 150000 },
    });
    expect(text).toContain('12 months at GMD 1,500.00 a month');
    expect(text).toContain('stays the property of Norex');
  });
});
