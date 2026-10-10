import { ConfigService } from '@nestjs/config';
import { MailService, escapeHtml } from './mail.service';

const message = { to: 'awa@norex.gm', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' };
const service = (env: Record<string, string>) =>
  new MailService({ get: (k: string) => env[k] } as unknown as ConfigService);

describe('MailService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends nothing without RESEND_API_KEY', async () => {
    global.fetch = jest.fn();
    await expect(service({}).send(message)).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts to Resend with the sender and reports success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    const ok = await service({
      RESEND_API_KEY: 're_test_123456',
      EMAIL_FROM: 'Norex <a@b.c>',
    }).send(message);
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_123456');
    expect(JSON.parse(init.body)).toMatchObject({ from: 'Norex <a@b.c>', to: ['awa@norex.gm'] });
  });

  it('reports failure when Resend refuses or is unreachable', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'no' });
    await expect(service({ RESEND_API_KEY: 're_test_123456' }).send(message)).resolves.toBe(false);
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(service({ RESEND_API_KEY: 're_test_123456' }).send(message)).resolves.toBe(false);
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
