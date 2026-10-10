import { deviceImageUrl } from './device-image';

describe('deviceImageUrl', () => {
  const base = 'https://norexgambia.com/';
  it('joins the website base and the stored path', () => {
    expect(deviceImageUrl({ webImages: { cutout: '/devices/a.png' } }, base)).toBe(
      'https://norexgambia.com/devices/a.png',
    );
  });
  it('prefers the cutout, falls back to the main image', () => {
    expect(deviceImageUrl({ webImages: { image: 'devices/b.webp' } }, base)).toBe(
      'https://norexgambia.com/devices/b.webp',
    );
  });
  it('returns null without a path or a base', () => {
    expect(deviceImageUrl({}, base)).toBeNull();
    expect(deviceImageUrl(null, base)).toBeNull();
    expect(deviceImageUrl({ webImages: { image: '/x.png' } }, undefined)).toBeNull();
  });
});
