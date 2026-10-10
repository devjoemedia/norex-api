import { staffPasswordProblem } from './staff-password';

describe('staffPasswordProblem', () => {
  it('accepts a long, varied password', () => {
    expect(staffPasswordProblem('river-mango-lantern-42', 'awa@norex.gm')).toBeNull();
  });

  it('refuses short or repetitive passwords', () => {
    expect(staffPasswordProblem('Sh0rt!pass', null)).toMatch(/at least 12/);
    expect(staffPasswordProblem('aaaaaaaaaaaaab', null)).toMatch(/varied/);
  });

  it('refuses the email name and common words', () => {
    expect(staffPasswordProblem('awajallow-2026!', 'awajallow@norex.gm')).toMatch(/email/);
    expect(staffPasswordProblem('Password2024!!', null)).toMatch(/common/);
  });
});
