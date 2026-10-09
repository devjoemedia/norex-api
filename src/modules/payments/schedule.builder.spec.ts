import { addMonths, buildSchedule } from './schedule.builder';

describe('repayment schedule builder', () => {
  const activatedAt = new Date('2026-01-31T00:00:00.000Z');

  it('builds a financing schedule: deposit (seq 0) + monthly instalments', () => {
    const s = buildSchedule({
      kind: 'financing',
      currency: 'GMD',
      months: 6,
      depositMinor: 2_400_000,
      monthlyMinor: 1_888_000,
      finalMonthlyMinor: 1_888_000,
      activatedAt,
    });
    expect(s.installments).toHaveLength(7); // deposit + 6
    expect(s.installments[0]).toMatchObject({ seq: 0, isDeposit: true, amountMinor: 2_400_000 });
    expect(s.installments[0].dueDate.getTime()).toBe(activatedAt.getTime());
    // total is deposit + all monthly instalments
    expect(s.totalAmountMinor).toBe(2_400_000 + 1_888_000 * 6);
  });

  it('puts the rounding remainder in the final instalment and stays integer', () => {
    const s = buildSchedule({
      kind: 'financing',
      currency: 'GMD',
      months: 3,
      depositMinor: 0,
      monthlyMinor: 1000,
      finalMonthlyMinor: 999,
      activatedAt,
    });
    // no deposit row when depositMinor is 0
    expect(s.installments.every((i) => !i.isDeposit)).toBe(true);
    expect(s.installments.map((i) => i.amountMinor)).toEqual([1000, 1000, 999]);
    expect(s.totalAmountMinor).toBe(2999);
    for (const i of s.installments) expect(Number.isInteger(i.amountMinor)).toBe(true);
  });

  it('builds a lease schedule of equal monthly fees, no deposit', () => {
    const s = buildSchedule({
      kind: 'lease',
      currency: 'GHS',
      months: 12,
      depositMinor: 0,
      monthlyMinor: 500000,
      finalMonthlyMinor: 500000,
      activatedAt,
    });
    expect(s.installments).toHaveLength(12);
    expect(s.installments.every((i) => !i.isDeposit)).toBe(true);
    expect(s.totalAmountMinor).toBe(500000 * 12);
  });

  it('clamps due dates to month length (Jan-31 + 1mo = Feb-28)', () => {
    const due = addMonths(new Date('2026-01-31T00:00:00.000Z'), 1);
    expect(due.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('is deterministic', () => {
    const input = {
      kind: 'financing' as const,
      currency: 'GMD',
      months: 9,
      depositMinor: 100,
      monthlyMinor: 200,
      finalMonthlyMinor: 150,
      activatedAt,
    };
    expect(buildSchedule(input)).toEqual(buildSchedule(input));
  });
});
