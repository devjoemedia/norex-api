import { applicationSteps, orderSteps, samePhone } from './track.service';

describe('tracking', () => {
  it('matches phones by their last 7 digits', () => {
    expect(samePhone('+2203001122', '300 1122')).toBe(true);
    expect(samePhone('+2203001122', '+220 300-1123')).toBe(false);
    expect(samePhone(null, '3001122')).toBe(false);
    expect(samePhone('+2203001122', '1122')).toBe(false);
  });

  it('shows one current step while an application moves', () => {
    const review = applicationSteps('under_review', 'financing');
    expect(review.filter((s) => s.current).map((s) => s.label)).toEqual(['Under review']);
    expect(review[0].done).toBe(true);
    const info = applicationSteps('info_requested', 'lease');
    expect(info[1].note).toMatch(/more information/);
  });

  it('ends a declined application at "Not approved"', () => {
    const steps = applicationSteps('declined', 'financing');
    expect(steps.at(-1)).toMatchObject({ label: 'Not approved', current: true });
    expect(steps.some((s) => s.label === 'Collect your device')).toBe(false);
  });

  it('marks everything done once the plan is active', () => {
    expect(applicationSteps('active', 'financing').every((s) => s.done)).toBe(true);
  });

  it('follows orders, for pickup and delivery', () => {
    expect(orderSteps('ready', 'pickup').find((s) => s.current)?.label).toBe(
      'Ready for collection',
    );
    expect(orderSteps('ready', 'delivery').find((s) => s.current)?.label).toBe('On its way');
    expect(orderSteps('completed', 'pickup').every((s) => s.done)).toBe(true);
    expect(orderSteps('cancelled', 'pickup').at(-1)?.label).toBe('Cancelled');
  });
});

describe('a new application', () => {
  it('is received and waiting for review', () => {
    const steps = applicationSteps('submitted', 'financing');
    expect(steps[0].done).toBe(true);
    expect(steps.find((s) => s.current)?.label).toBe('Under review');
  });
});
