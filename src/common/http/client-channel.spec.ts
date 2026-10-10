import { channelFromHeader, deviceTypeFromClient, deviceTypeFromUserAgent } from './client-channel';

describe('client channel', () => {
  it('maps the app header and defaults to api', () => {
    expect(channelFromHeader('mobile-app')).toBe('mobile_app');
    expect(channelFromHeader('Mobile App')).toBe('mobile_app');
    expect(channelFromHeader('website')).toBe('website');
    expect(channelFromHeader(undefined)).toBe('api');
    expect(channelFromHeader('something-else')).toBe('api');
  });

  it('classifies phones, tablets and desktops', () => {
    expect(
      deviceTypeFromUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      ),
    ).toBe('mobile');
    expect(
      deviceTypeFromUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/120 Mobile Safari/537.36',
      ),
    ).toBe('mobile');
    expect(deviceTypeFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(
      deviceTypeFromUserAgent('Mozilla/5.0 (Linux; Android 13; SM-X700) Chrome/120 Safari/537.36'),
    ).toBe('tablet');
    expect(
      deviceTypeFromUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36',
      ),
    ).toBe('desktop');
    expect(deviceTypeFromUserAgent(undefined)).toBeNull();
  });

  it('prefers the device the app declares over the User-Agent', () => {
    const iosApp = 'Norex/1 CFNetwork/1490.0.4 Darwin/23.2.0';
    expect(deviceTypeFromUserAgent(iosApp)).toBe('desktop'); // why the app must declare it
    expect(deviceTypeFromClient('mobile', iosApp)).toBe('mobile');
    expect(deviceTypeFromClient('Tablet', iosApp)).toBe('tablet');
    expect(deviceTypeFromClient('watch', 'Mozilla/5.0 (iPhone)')).toBe('mobile');
    expect(deviceTypeFromClient(undefined, undefined)).toBeNull();
  });
});
