import {
  assertTemplateVars,
  renderTemplate,
  sanitizeHtml,
  TemplateError,
  templateVars,
} from './template.render';

describe('notification template rendering (logic-less, fail-closed)', () => {
  const allow = ['code', 'ttlMinutes', 'fullName'];

  it('substitutes allowed variables', () => {
    expect(
      renderTemplate(
        'Your code is {{code}} ({{ttlMinutes}}m)',
        { code: 123456, ttlMinutes: 5 },
        allow,
      ),
    ).toBe('Your code is 123456 (5m)');
  });

  it('rejects a variable outside the allow-list', () => {
    expect(() => renderTemplate('Hi {{secret}}', { secret: 'x' }, allow)).toThrow(TemplateError);
  });

  it('fails closed on a missing/empty value', () => {
    expect(() => renderTemplate('Hi {{fullName}}', {}, allow)).toThrow(TemplateError);
    expect(() => renderTemplate('Hi {{fullName}}', { fullName: '' }, allow)).toThrow(TemplateError);
  });

  it('never executes logic — braces without a known token are literal', () => {
    // no expressions/loops; only {{var}} is meaningful
    expect(renderTemplate('2+2 = {{code}}', { code: 4 }, allow)).toBe('2+2 = 4');
  });

  it('extracts and validates referenced variables', () => {
    expect(templateVars('a {{code}} b {{code}} c {{fullName}}').sort()).toEqual([
      'code',
      'fullName',
    ]);
    expect(() => assertTemplateVars('{{nope}}', allow)).toThrow(TemplateError);
  });

  it('sanitizes HTML: strips scripts, handlers and javascript: urls', () => {
    const dirty = `<p onclick="steal()">hi</p><script>evil()</script><a href="javascript:evil()">x</a>`;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('<p>hi</p>');
  });
});
