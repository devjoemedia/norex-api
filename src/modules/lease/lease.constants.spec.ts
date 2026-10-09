import { LeaseStatus } from '@prisma/client';
import { canLeaseTransition } from './lease.constants';

describe('lease transitions', () => {
  it('allows active → returned and active → upgraded', () => {
    expect(canLeaseTransition(LeaseStatus.active, LeaseStatus.returned)).toBe(true);
    expect(canLeaseTransition(LeaseStatus.active, LeaseStatus.upgraded)).toBe(true);
  });

  it('treats returned and upgraded as terminal', () => {
    expect(canLeaseTransition(LeaseStatus.returned, LeaseStatus.active)).toBe(false);
    expect(canLeaseTransition(LeaseStatus.upgraded, LeaseStatus.active)).toBe(false);
    expect(canLeaseTransition(LeaseStatus.returned, LeaseStatus.upgraded)).toBe(false);
  });

  it('rejects a no-op active → active', () => {
    expect(canLeaseTransition(LeaseStatus.active, LeaseStatus.active)).toBe(false);
  });
});
