import { ApplicationType, NotificationEventKey } from '@prisma/client';
import { EVENTS, PLATFORM_DEFAULTS } from './notification.constants';
import { renderTemplate } from './template.render';
import { planText } from './customer-notifier.service';
import { emailBodies } from './channels/email.adapter';

const CUSTOMER_EVENTS: NotificationEventKey[] = [
  'application_received',
  'application_approved',
  'application_declined',
  'application_info_requested',
  'order_received',
  'order_ready',
  'order_cancelled',
];

const SAMPLE = {
  fullName: 'Awa',
  reference: 'BNP-7K2QXA',
  kind: 'installment plan',
  product: 'iPhone 16 128GB',
  plan: '6 monthly payments of GMD 6,975.00',
  reason: 'A clearer photo of the back of your ID',
  country: 'Norex Gambia',
  items: '1 × iPhone 16 128GB Black',
  total: 'GMD 41,850.00',
  collection: 'Collect at: Westfield, Serrekunda.',
};

describe('customer email templates', () => {
  it.each(CUSTOMER_EVENTS)('%s renders with only its allowed details', (event) => {
    const tpl = PLATFORM_DEFAULTS[event]?.email;
    expect(tpl).toBeDefined();
    const allow = EVENTS[event].vars;
    const vars = Object.fromEntries(allow.map((k) => [k, SAMPLE[k as keyof typeof SAMPLE]]));
    expect(() => renderTemplate(tpl!.subject!, vars, allow)).not.toThrow();
    const body = renderTemplate(tpl!.body, vars, allow);
    expect(body).toContain('Awa');
    expect(body).not.toMatch(/\{\{/);
  });

  it('never tells a declined applicant the internal reason', () => {
    expect(EVENTS.application_declined.vars).not.toContain('reason');
  });
});

describe('planText', () => {
  it('describes each kind of plan', () => {
    const none = { financeMonths: null, leaseMonths: null };
    expect(
      planText(
        ApplicationType.financing,
        { months: 6, monthlyMinor: 697500, depositMinor: 200000, currency: 'GMD' },
        'GMD',
        none,
      ),
    ).toBe('6 monthly payments of GMD 6,975.00, after a GMD 2,000.00 deposit');
    expect(planText(ApplicationType.lease, { months: 12, monthlyMinor: 150000 }, 'GMD', none)).toBe(
      'GMD 1,500.00 a month for 12 months',
    );
    expect(
      planText(
        ApplicationType.financing,
        {
          months: 6,
          monthlyMinor: 697500,
          frequency: 'weekly',
          periods: 26,
          periodMinor: 160961,
          currency: 'GMD',
        },
        'GMD',
        none,
      ),
    ).toBe('26 weekly payments of GMD 1,609.61');
    expect(planText(ApplicationType.trade_in, null, 'GMD', none)).toBe(
      'Trade-in towards a new device',
    );
    expect(
      planText(ApplicationType.financing, null, 'GMD', { financeMonths: 3, leaseMonths: null }),
    ).toBe('3 monthly payments');
  });
});

describe('emailBodies', () => {
  it('turns plain text into escaped paragraphs', () => {
    const { html, text } = emailBodies('Hello <b>Awa</b>,\n\nLine one\nLine two');
    expect(html).toContain('&lt;b&gt;Awa&lt;/b&gt;');
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html).toContain('Line one<br>Line two');
    expect(text).toContain('Line one\nLine two');
  });

  it('sanitizes HTML templates', () => {
    const { html, text } = emailBodies('<p onclick="x()">Hi</p><script>alert(1)</script>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('script');
    expect(text).toBe('Hi');
  });
});
