// CORS allowlist from CORS_ORIGINS: exact origins, or `https://*.example.pages.dev`
// for Cloudflare preview deploys. Never a bare wildcard.
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s && s !== '*');
}

export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (!entry.includes('*')) return entry === origin;
    const [scheme, host] = entry.split('://');
    if (!host?.startsWith('*.')) return false;
    try {
      const url = new URL(origin);
      // One wildcard label, same scheme: `https://*.x.dev` matches `https://a.x.dev` only.
      const suffix = host.slice(1);
      const label = url.host.slice(0, -suffix.length);
      return (
        url.protocol === `${scheme}:` &&
        url.host.endsWith(suffix) &&
        label.length > 0 &&
        !label.includes('.')
      );
    } catch {
      return false;
    }
  });
}
