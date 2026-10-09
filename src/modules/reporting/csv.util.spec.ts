import { toCsv } from './csv.util';

describe('csv encoder (RFC 4180, dependency-free)', () => {
  it('emits a header row followed by data rows', () => {
    const out = toCsv([{ a: 1, b: 2 }], ['a', 'b']);
    expect(out).toBe('a,b\r\n1,2');
  });

  it('only emits the header when there are no rows', () => {
    expect(toCsv([], ['day', 'count'])).toBe('day,count');
  });

  it('quotes fields containing a comma', () => {
    const out = toCsv([{ name: 'Banjul, GM' }], ['name']);
    expect(out).toBe('name\r\n"Banjul, GM"');
  });

  it('quotes and doubles embedded double-quotes', () => {
    const out = toCsv([{ note: 'a "quoted" word' }], ['note']);
    expect(out).toBe('note\r\n"a ""quoted"" word"');
  });

  it('quotes fields containing newlines (LF and CR)', () => {
    expect(toCsv([{ v: 'line1\nline2' }], ['v'])).toBe('v\r\n"line1\nline2"');
    expect(toCsv([{ v: 'line1\r\nline2' }], ['v'])).toBe('v\r\n"line1\r\nline2"');
  });

  it('renders null/undefined/missing cells as empty', () => {
    const out = toCsv([{ a: null, b: undefined }], ['a', 'b', 'c']);
    expect(out).toBe('a,b,c\r\n,,');
  });

  it('projects only the requested columns, in order', () => {
    const out = toCsv([{ b: 2, a: 1, secret: 'x' }], ['a', 'b']);
    expect(out).toBe('a,b\r\n1,2');
  });
});
