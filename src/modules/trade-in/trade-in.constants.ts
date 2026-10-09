import { TradeInStatus } from '@prisma/client';

// Whitelisted trade-in lifecycle transitions — the single source of truth (docs/06).
// Any move not listed here is rejected. quoted → quoted is a re-valuation (supersede).
export const TRADE_IN_TRANSITIONS: Record<TradeInStatus, TradeInStatus[]> = {
  [TradeInStatus.draft]: [TradeInStatus.submitted],
  [TradeInStatus.submitted]: [TradeInStatus.quoted],
  [TradeInStatus.quoted]: [TradeInStatus.accepted, TradeInStatus.expired, TradeInStatus.quoted],
  [TradeInStatus.accepted]: [],
  [TradeInStatus.expired]: [],
};

export function canTradeInTransition(from: TradeInStatus, to: TradeInStatus): boolean {
  return TRADE_IN_TRANSITIONS[from].includes(to);
}

export const REFERENCE_PREFIX = 'TRD';
