import { sanitizeContentBody, sanitizeHtml } from './sanitize.util';

describe('content HTML sanitizer (allow-list)', () => {
  it('strips <script> blocks and their contents', () => {
    const clean = sanitizeHtml('<p>hi</p><script>evil()</script>');
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toContain('evil()');
    expect(clean).toContain('<p>hi</p>');
  });

  it('strips inline on* event handlers', () => {
    const clean = sanitizeHtml('<p onclick="steal()">hi</p>');
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).toContain('<p>hi</p>');
  });

  it('neutralizes javascript: URIs on links', () => {
    const clean = sanitizeHtml('<a href="javascript:evil()">x</a>');
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('x</a>');
  });

  it('drops non-whitelisted tags but keeps their text', () => {
    const clean = sanitizeHtml('<div><span>keep me</span></div>');
    expect(clean).not.toMatch(/<div|<span/i);
    expect(clean).toContain('keep me');
  });

  it('keeps whitelisted rich-text tags and safe attributes', () => {
    const clean = sanitizeHtml(
      '<h2>Title</h2><p><strong>bold</strong> <a href="/plans">link</a></p>',
    );
    expect(clean).toContain('<h2>Title</h2>');
    expect(clean).toContain('<strong>bold</strong>');
    expect(clean).toContain('<a href="/plans">link</a>');
  });

  it('keeps img with src/alt only and drops other attributes', () => {
    const clean = sanitizeHtml('<img src="/a.png" alt="A" onerror="x()" width="10">');
    expect(clean).toContain('src="/a.png"');
    expect(clean).toContain('alt="A"');
    expect(clean).not.toMatch(/onerror|width/i);
  });

  it('rejects data: URIs on images', () => {
    const clean = sanitizeHtml('<img src="data:text/html,<script>x</script>" alt="a">');
    expect(clean).not.toMatch(/data:/i);
    expect(clean).toContain('alt="a"');
  });

  it('walks a JSON body and sanitizes nested string values', () => {
    const body = {
      heading: 'Welcome',
      html: '<p onclick="x()">hi</p><script>bad()</script>',
      items: ['<em>ok</em>', '<script>nope()</script>'],
      nested: { note: '<a href="javascript:bad()">y</a>' },
    };
    const clean = sanitizeContentBody(body) as typeof body;
    expect(clean.heading).toBe('Welcome');
    expect(clean.html).not.toMatch(/onclick|<script/i);
    expect(clean.html).toContain('<p>hi</p>');
    expect(clean.items[0]).toBe('<em>ok</em>');
    expect(clean.items[1]).not.toMatch(/<script/i);
    expect(clean.nested.note).not.toMatch(/javascript:/i);
  });

  it('leaves non-string primitives untouched', () => {
    const body = { count: 3, active: true, missing: null };
    expect(sanitizeContentBody(body)).toEqual(body);
  });
});
