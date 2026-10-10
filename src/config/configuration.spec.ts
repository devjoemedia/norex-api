import { validateEnv } from './configuration';

describe('validateEnv', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'x'.repeat(32),
  };

  it('treats blank optional settings as unset (e.g. REDIS_URL="")', () => {
    const env = validateEnv({ ...base, REDIS_URL: '', S3_ENDPOINT: '  ', WEB_INTAKE_KEY: '' });
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.WEB_INTAKE_KEY).toBeUndefined();
  });

  it('still rejects a malformed value and a missing required one', () => {
    expect(() => validateEnv({ ...base, REDIS_URL: 'not a url' })).toThrow(/REDIS_URL/);
    expect(() => validateEnv({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
