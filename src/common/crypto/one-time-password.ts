import { randomBytes } from 'node:crypto';

// A strong, typeable one-time password for staff invites/resets. Shown once to the
// admin who created it; the staff member then enrols TOTP at first sign-in.
export function generateOneTimePassword(): string {
  return randomBytes(12).toString('base64url');
}
