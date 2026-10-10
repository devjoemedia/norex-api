// Where requests come from (docs/19): counts per channel, request type and device,
// plus a daily trend. Pure functions so per-country results add up for "all countries".

export const CHANNEL_KEYS = ['website', 'mobile_app', 'portal', 'api', 'unknown'] as const;
export const DEVICE_KEYS = ['mobile', 'tablet', 'desktop', 'unknown'] as const;
export const CATEGORY_KEYS = ['orders', 'financing', 'lease', 'trade_in'] as const;

type ChannelKey = (typeof CHANNEL_KEYS)[number];
type DeviceKey = (typeof DEVICE_KEYS)[number];
type CategoryKey = (typeof CATEGORY_KEYS)[number];

export interface ChannelRow {
  channel: ChannelKey;
  total: number;
  orders: number;
  financing: number;
  lease: number;
  trade_in: number;
}

export interface ChannelAnalytics {
  days: number;
  total: number;
  channels: ChannelRow[];
  devices: Array<{ deviceType: DeviceKey; count: number }>;
  trend: Array<{ date: string } & Record<ChannelKey, number>>;
}

export interface RequestOrigin {
  category: CategoryKey;
  channel: string | null;
  deviceType: string | null;
  createdAt: Date;
}

const asChannel = (c: string | null): ChannelKey =>
  (CHANNEL_KEYS as readonly string[]).includes(c ?? '') ? (c as ChannelKey) : 'unknown';
const asDevice = (d: string | null): DeviceKey =>
  (DEVICE_KEYS as readonly string[]).includes(d ?? '') ? (d as DeviceKey) : 'unknown';
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function summariseOrigins(
  rows: RequestOrigin[],
  days: number,
  now = new Date(),
): ChannelAnalytics {
  const channels = new Map<ChannelKey, ChannelRow>(
    CHANNEL_KEYS.map((c) => [
      c,
      { channel: c, total: 0, orders: 0, financing: 0, lease: 0, trade_in: 0 },
    ]),
  );
  const devices = new Map<DeviceKey, number>(DEVICE_KEYS.map((d) => [d, 0]));
  const trend = new Map<string, { date: string } & Record<ChannelKey, number>>();
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKey(new Date(now.getTime() - i * 86_400_000));
    trend.set(date, {
      date,
      ...(Object.fromEntries(CHANNEL_KEYS.map((c) => [c, 0])) as Record<ChannelKey, number>),
    });
  }

  for (const r of rows) {
    const ch = asChannel(r.channel);
    const row = channels.get(ch)!;
    row.total++;
    row[r.category]++;
    // Device type only means something for customer-facing channels.
    if (ch === 'website' || ch === 'mobile_app') {
      const d = asDevice(r.deviceType);
      devices.set(d, (devices.get(d) ?? 0) + 1);
    }
    const day = trend.get(dayKey(r.createdAt));
    if (day) day[ch]++;
  }

  return {
    days,
    total: rows.length,
    channels: [...channels.values()],
    devices: [...devices].map(([deviceType, count]) => ({ deviceType, count })),
    trend: [...trend.values()],
  };
}

// "All countries": counts add up (no money here, so no currency mixing).
export function mergeChannelAnalytics(list: ChannelAnalytics[]): ChannelAnalytics {
  if (list.length === 1) return list[0];
  const days = list[0]?.days ?? 30;
  const out = summariseOrigins([], days);
  for (const a of list) {
    out.total += a.total;
    a.channels.forEach((c, i) => {
      const t = out.channels[i];
      t.total += c.total;
      t.orders += c.orders;
      t.financing += c.financing;
      t.lease += c.lease;
      t.trade_in += c.trade_in;
    });
    a.devices.forEach((d, i) => (out.devices[i].count += d.count));
    const byDate = new Map(out.trend.map((t) => [t.date, t]));
    for (const day of a.trend) {
      const t = byDate.get(day.date);
      if (t) for (const c of CHANNEL_KEYS) t[c] += day[c];
    }
  }
  return out;
}
