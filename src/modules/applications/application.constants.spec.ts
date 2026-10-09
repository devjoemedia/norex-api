import { ApplicationStatus as S } from '@prisma/client';
import { canTransition } from './application.constants';

describe('application state machine', () => {
  it('allows the happy path through to active', () => {
    expect(canTransition(S.draft, S.submitted)).toBe(true);
    expect(canTransition(S.submitted, S.under_review)).toBe(true);
    expect(canTransition(S.under_review, S.approved)).toBe(true);
    expect(canTransition(S.approved, S.agreement_pending)).toBe(true);
    expect(canTransition(S.agreement_pending, S.active)).toBe(true);
  });

  it('allows the info-requested loop and withdrawal', () => {
    expect(canTransition(S.under_review, S.info_requested)).toBe(true);
    expect(canTransition(S.info_requested, S.submitted)).toBe(true);
    expect(canTransition(S.draft, S.withdrawn)).toBe(true);
    expect(canTransition(S.submitted, S.withdrawn)).toBe(true);
  });

  it('rejects illegal moves, skips, and terminal states', () => {
    expect(canTransition(S.draft, S.approved)).toBe(false); // must be reviewed first
    expect(canTransition(S.submitted, S.approved)).toBe(false); // must go under_review
    expect(canTransition(S.approved, S.active)).toBe(false); // must pass agreement_pending
    expect(canTransition(S.declined, S.approved)).toBe(false); // terminal
    expect(canTransition(S.active, S.withdrawn)).toBe(false); // terminal
    expect(canTransition(S.withdrawn, S.submitted)).toBe(false); // terminal
  });
});
