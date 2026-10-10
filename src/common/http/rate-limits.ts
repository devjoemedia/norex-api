// Tighter per-route limits on top of the global THROTTLE_LIMIT (per IP, per minute).
// Keyed per route, so each limit only counts calls to that endpoint.
const MINUTE = 60_000;

export const RATE_LIMITS = {
  // Per applicant IP (forwarded by the website): room to fix a few form errors.
  webIntake: { default: { limit: 10, ttl: 10 * MINUTE } },
  // Mobile app (no key): per caller IP. Shared mobile-carrier IPs need some headroom.
  appIntake: { default: { limit: 20, ttl: 10 * MINUTE } },
  // Order/application tracking: per IP (forwarded by the website), enough for a few typos.
  track: { default: { limit: 20, ttl: 10 * MINUTE } },
  otp: { default: { limit: 5, ttl: MINUTE } },
  staffSignIn: { default: { limit: 10, ttl: 15 * MINUTE } },
  tokenRefresh: { default: { limit: 30, ttl: MINUTE } },
};
