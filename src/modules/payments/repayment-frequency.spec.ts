import { atFrequency, periodsFor, splitTotal } from './repayment-frequency';
import { buildSchedule } from './schedule.builder';

describe('repayment frequency', () => {
  it('counts payments per term', () => {
    expect(periodsFor(6, 'monthly')).toBe(6);
    expect(periodsFor(6, 'biweekly')).toBe(13);
    expect(periodsFor(6, 'weekly')).toBe(26);
    expect(periodsFor(12, 'weekly')).toBe(52);
    expect(periodsFor(3, 'biweekly')).toBe(7); // 6.5 rounds up
  });

  it('splits exactly, remainder last', () => {
    expect(splitTotal(1000, 3)).toEqual({ periodMinor: 333, finalPeriodMinor: 334 });
  });

  it('keeps the monthly total', () => {
    const term = { months: 6, monthlyMinor: 697500, finalMonthlyMinor: 697502 };
    const monthlyTotal = 697500 * 5 + 697502;
    for (const f of ['biweekly', 'weekly'] as const) {
      const p = atFrequency(term, f);
      expect(p.periodMinor * (p.periods - 1) + p.finalPeriodMinor).toBe(monthlyTotal);
    }
  });

  it('builds weekly schedules 7 days apart, deposit untouched', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const s = buildSchedule({
      kind: 'financing',
      currency: 'GMD',
      months: 6,
      depositMinor: 200000,
      monthlyMinor: 697500,
      finalMonthlyMinor: 697500,
      activatedAt: start,
      frequency: 'weekly',
    });
    expect(s.installments).toHaveLength(27); // deposit + 26
    expect(s.installments[1].dueDate.toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(s.installments[26].dueDate.toISOString()).toBe('2026-07-02T00:00:00.000Z');
    expect(s.totalAmountMinor).toBe(200000 + 697500 * 6);
  });

  it('keeps leases monthly whatever is asked', () => {
    const s = buildSchedule({
      kind: 'lease',
      currency: 'GMD',
      months: 6,
      depositMinor: 0,
      monthlyMinor: 1000,
      finalMonthlyMinor: 1000,
      activatedAt: new Date('2026-01-01T00:00:00Z'),
      frequency: 'weekly',
    });
    expect(s.installments).toHaveLength(6);
  });
});
