import { ApplicationStatus, Role } from '@prisma/client';

// Whitelisted status transitions — the single source of truth for the lifecycle
// (docs/07-applications-approvals.md). Any move not listed here is rejected.
export const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  [ApplicationStatus.draft]: [ApplicationStatus.submitted, ApplicationStatus.withdrawn],
  [ApplicationStatus.submitted]: [ApplicationStatus.under_review, ApplicationStatus.withdrawn],
  [ApplicationStatus.under_review]: [
    ApplicationStatus.approved,
    ApplicationStatus.info_requested,
    ApplicationStatus.declined,
  ],
  [ApplicationStatus.info_requested]: [ApplicationStatus.submitted, ApplicationStatus.withdrawn],
  [ApplicationStatus.approved]: [ApplicationStatus.agreement_pending],
  [ApplicationStatus.agreement_pending]: [ApplicationStatus.active],
  [ApplicationStatus.declined]: [],
  [ApplicationStatus.active]: [],
  [ApplicationStatus.withdrawn]: [],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// Reference prefixes by application type.
export const REFERENCE_PREFIX = { financing: 'BNP', lease: 'LSE', trade_in: 'TRD' } as const;

// Roles allowed to review and decide.
export const STAFF_DECISION_ROLES: Role[] = [
  Role.approvals_officer,
  Role.country_manager,
  Role.super_admin,
];

export function isDecisionStaff(roles: string[]): boolean {
  return roles.some((r) => (STAFF_DECISION_ROLES as string[]).includes(r));
}

export enum DecisionAction {
  approve = 'approve',
  request_info = 'request_info',
  decline = 'decline',
}
