import {
  affordabilityFlag,
  monthlyIncomeMinor,
  monthlyPaymentMinor,
  riskLevel,
} from './risk.service';

describe('risk checks', () => {
  it('turns income into a monthly figure', () => {
    expect(monthlyIncomeMinor('15000', 'Monthly')).toBe(1_500_000);
    expect(monthlyIncomeMinor('3,000', 'Weekly')).toBe(1_300_000);
    expect(monthlyIncomeMinor('500', 'Daily')).toBe(1_300_000);
    expect(monthlyIncomeMinor('', 'Monthly')).toBeNull();
  });

  it('turns any repayment frequency into a monthly payment', () => {
    expect(monthlyPaymentMinor({ monthlyMinor: 697500 })).toBe(697500);
    expect(
      monthlyPaymentMinor({ frequency: 'weekly', periodMinor: 160961, monthlyMinor: 697500 }),
    ).toBe(697498);
    expect(monthlyPaymentMinor(null)).toBeNull();
  });

  it('flags payments that take a big share of income', () => {
    expect(affordabilityFlag(300_000, 1_500_000)).toBeNull(); // 20%
    expect(affordabilityFlag(600_000, 1_500_000)?.severity).toBe('medium'); // 40%
    expect(affordabilityFlag(900_000, 1_500_000)?.severity).toBe('high'); // 60%
    expect(affordabilityFlag(600_000, null)?.code).toBe('income_missing');
  });

  it('rolls flags up to one level', () => {
    expect(riskLevel([])).toBe('low');
    expect(riskLevel([{ code: 'a', severity: 'medium', label: '', detail: '' }])).toBe('medium');
    expect(
      riskLevel([
        { code: 'a', severity: 'medium', label: '', detail: '' },
        { code: 'b', severity: 'high', label: '', detail: '' },
      ]),
    ).toBe('high');
  });
});
