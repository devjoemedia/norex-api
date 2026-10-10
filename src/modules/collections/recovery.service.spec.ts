import { reminderStage } from './recovery.service';

const due = new Date('2026-10-20T00:00:00Z');
const at = (iso: string) => reminderStage(due, new Date(iso));

describe('reminderStage', () => {
  it('reminds 3 days before and 1, 7, 14 days late', () => {
    expect(at('2026-10-17T09:00:00Z')).toBe(-3);
    expect(at('2026-10-21T09:00:00Z')).toBe(1);
    expect(at('2026-10-27T09:00:00Z')).toBe(7);
    expect(at('2026-11-03T09:00:00Z')).toBe(14);
  });

  it('catches up if a run is missed, and stays quiet in between', () => {
    expect(at('2026-10-18T09:00:00Z')).toBe(-3); // day after the "3 days before" mark
    expect(at('2026-10-24T09:00:00Z')).toBeNull();
    expect(at('2026-11-10T09:00:00Z')).toBeNull();
  });
});
