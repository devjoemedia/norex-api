import { BadRequestException } from '@nestjs/common';

// Rules for a password a staff member chooses (invite, first sign-in, change).
// Length does most of the work; the rest blocks the obvious guesses. Two-factor is
// always on for staff, so this is the first of two locks, not the only one.
export const STAFF_PASSWORD_MIN = 12;
export const STAFF_PASSWORD_MAX = 128;

const COMMON = ['password', 'norex', 'qwerty', 'letmein', 'welcome', 'admin', '123456', 'iloveyou'];

/** The reason a password is refused, or null when it's acceptable. */
export function staffPasswordProblem(password: string, email?: string | null): string | null {
  if (password.length < STAFF_PASSWORD_MIN) {
    return `Use at least ${STAFF_PASSWORD_MIN} characters`;
  }
  if (password.length > STAFF_PASSWORD_MAX) {
    return `Use at most ${STAFF_PASSWORD_MAX} characters`;
  }
  if (new Set(password).size < 5) return 'Use more varied characters';
  const lower = password.toLowerCase();
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) {
    return "Don't include your email address";
  }
  // Mostly a common word plus a few digits/symbols, e.g. "Password2024!".
  const letters = lower.replace(/[^a-z]/g, '');
  if (COMMON.some((w) => lower.includes(w) && letters.length - w.length < 4)) {
    return 'Avoid common words like "password" or "norex"';
  }
  return null;
}

export function assertStaffPassword(password: string, email?: string | null): void {
  const problem = staffPasswordProblem(password, email);
  if (problem) throw new BadRequestException(problem);
}
