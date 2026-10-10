import { mergeChannelAnalytics, summariseOrigins } from './channel-analytics';

describe('channel analytics', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const rows = [
    { category: 'financing' as const, channel: 'website', deviceType: 'mobile', createdAt: now },
    { category: 'orders' as const, channel: 'website', deviceType: 'desktop', createdAt: now },
    { category: 'lease' as const, channel: 'mobile_app', deviceType: 'mobile', createdAt: now },
    { category: 'financing' as const, channel: 'portal', deviceType: null, createdAt: now },
    { category: 'trade_in' as const, channel: null, deviceType: null, createdAt: now },
  ];

  it('counts per channel, type and device', () => {
    const a = summariseOrigins(rows, 7, now);
    const by = Object.fromEntries(a.channels.map((c) => [c.channel, c]));
    expect(a.total).toBe(5);
    expect(by.website).toMatchObject({ total: 2, financing: 1, orders: 1 });
    expect(by.mobile_app).toMatchObject({ total: 1, lease: 1 });
    expect(by.portal.total).toBe(1);
    expect(by.unknown.trade_in).toBe(1);
    // Devices only for customer channels (website + app).
    const dev = Object.fromEntries(a.devices.map((d) => [d.deviceType, d.count]));
    expect(dev).toMatchObject({ mobile: 2, desktop: 1, tablet: 0, unknown: 0 });
    expect(a.trend).toHaveLength(7);
    expect(a.trend[6]).toMatchObject({ date: '2026-10-10', website: 2, mobile_app: 1 });
  });

  it('adds countries together', () => {
    const a = summariseOrigins(rows, 7, now);
    const merged = mergeChannelAnalytics([a, a]);
    expect(merged.total).toBe(10);
    expect(merged.channels.find((c) => c.channel === 'website')!.total).toBe(4);
  });
});
