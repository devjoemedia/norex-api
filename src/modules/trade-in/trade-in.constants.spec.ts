import { TradeInStatus } from '@prisma/client';
import { canTradeInTransition } from './trade-in.constants';

describe('trade-in transitions', () => {
  it('walks draft → submitted → quoted', () => {
    expect(canTradeInTransition(TradeInStatus.draft, TradeInStatus.submitted)).toBe(true);
    expect(canTradeInTransition(TradeInStatus.submitted, TradeInStatus.quoted)).toBe(true);
  });

  it('allows quoted → accepted, expired, and re-valuation (quoted → quoted)', () => {
    expect(canTradeInTransition(TradeInStatus.quoted, TradeInStatus.accepted)).toBe(true);
    expect(canTradeInTransition(TradeInStatus.quoted, TradeInStatus.expired)).toBe(true);
    expect(canTradeInTransition(TradeInStatus.quoted, TradeInStatus.quoted)).toBe(true);
  });

  it('treats accepted and expired as terminal', () => {
    expect(canTradeInTransition(TradeInStatus.accepted, TradeInStatus.quoted)).toBe(false);
    expect(canTradeInTransition(TradeInStatus.expired, TradeInStatus.quoted)).toBe(false);
    expect(canTradeInTransition(TradeInStatus.accepted, TradeInStatus.expired)).toBe(false);
  });

  it('rejects skipping submitted (draft → quoted)', () => {
    expect(canTradeInTransition(TradeInStatus.draft, TradeInStatus.quoted)).toBe(false);
  });

  it('rejects a no-op draft → draft', () => {
    expect(canTradeInTransition(TradeInStatus.draft, TradeInStatus.draft)).toBe(false);
  });
});
