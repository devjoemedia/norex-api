// Where a request came from (docs/19). The website and portal are set by the API
// itself; the mobile app identifies itself with `X-Client-Channel: mobile-app`.
export const CHANNELS = ['website', 'mobile_app', 'portal', 'api'] as const;
export type Channel = (typeof CHANNELS)[number];

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export function channelFromHeader(value: string | undefined): Channel {
  const v = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (v === 'mobile-app' || v === 'app') return 'mobile_app';
  if (v === 'website' || v === 'web') return 'website';
  return 'api';
}

// The app states its own form factor (X-Client-Device); trust that over a UA guess.
export function deviceTypeFromClient(
  declared: string | undefined,
  ua: string | undefined | null,
): DeviceType | null {
  const d = declared?.trim().toLowerCase();
  if (d === 'mobile' || d === 'tablet' || d === 'desktop') return d;
  return deviceTypeFromUserAgent(ua);
}

// Coarse device class from a User-Agent. Tablets first: iPads/Android tablets also
// match generic mobile patterns.
export function deviceTypeFromUserAgent(ua: string | undefined | null): DeviceType | null {
  if (!ua) return null;
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini|okhttp|Expo|Dart/i.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
}
