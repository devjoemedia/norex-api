import { isAllowedOrigin, parseOrigins } from './cors';

describe('cors allowlist', () => {
  const allowed = parseOrigins(
    'https://admin.norexgambia.com/, https://*.norex-admin.pages.dev, *, http://localhost:3100',
  );

  it('drops a bare wildcard and trailing slashes', () => {
    expect(allowed).toEqual([
      'https://admin.norexgambia.com',
      'https://*.norex-admin.pages.dev',
      'http://localhost:3100',
    ]);
  });

  it('strips quotes pasted around the whole value or each origin', () => {
    expect(parseOrigins('"https://admin.norexgambia.com,http://localhost:3100"')).toEqual([
      'https://admin.norexgambia.com',
      'http://localhost:3100',
    ]);
    expect(parseOrigins('\'https://a.com/\' , "http://localhost:3100"')).toEqual([
      'https://a.com',
      'http://localhost:3100',
    ]);
  });

  it('matches exact origins', () => {
    expect(isAllowedOrigin('https://admin.norexgambia.com', allowed)).toBe(true);
    expect(isAllowedOrigin('http://localhost:3100', allowed)).toBe(true);
    expect(isAllowedOrigin('https://evil.com', allowed)).toBe(false);
  });

  it('matches one subdomain label for a wildcard entry', () => {
    expect(isAllowedOrigin('https://abc123.norex-admin.pages.dev', allowed)).toBe(true);
    expect(isAllowedOrigin('https://a.b.norex-admin.pages.dev', allowed)).toBe(false);
    expect(isAllowedOrigin('http://abc.norex-admin.pages.dev', allowed)).toBe(false);
    expect(isAllowedOrigin('https://norex-admin.pages.dev', allowed)).toBe(false);
    expect(isAllowedOrigin('https://evilnorex-admin.pages.dev', allowed)).toBe(false);
  });
});
