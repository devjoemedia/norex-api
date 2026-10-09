import { LeaseStatus } from '@prisma/client';

// Whitelisted lease lifecycle transitions — the single source of truth (docs/05).
// Any move not listed here is rejected.
export const LEASE_TRANSITIONS: Record<LeaseStatus, LeaseStatus[]> = {
  [LeaseStatus.active]: [LeaseStatus.returned, LeaseStatus.upgraded],
  [LeaseStatus.returned]: [],
  [LeaseStatus.upgraded]: [],
};

export function canLeaseTransition(from: LeaseStatus, to: LeaseStatus): boolean {
  return LEASE_TRANSITIONS[from].includes(to);
}

export const LEASE_REFERENCE_PREFIX = 'LSE';
