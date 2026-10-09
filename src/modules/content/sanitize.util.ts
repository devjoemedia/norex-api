// Server-side rich-text/HTML sanitizer (allow-list) run on every content write, so
// stored bodies can never execute script in SSR output (docs/11). Hand-rolled with
// regex — no runtime deps — and deliberately conservative: unknown tags are dropped
// (their text kept), only whitelisted attributes survive, and script/style blocks,
// on* handlers and javascript:/data: URIs are stripped. Mirrors the notifications
// module's hand-rolled sanitize, extended to a tag/attribute allow-list.

const ALLOWED_TAGS = new Set([
  'p',
  'a',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'br',
  'blockquote',
  'img',
]);
// Attributes kept per tag; everything else (incl. on* handlers, style, class) is dropped.
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt'],
};
const VOID_TAGS = new Set(['br', 'img']);
// Blocks whose content must go too, not just the tag markers.
const BLOCK_TAGS = 'script|style|iframe|object|embed|noscript|template';
const DANGEROUS_URI = /^\s*(javascript|data|vbscript):/i;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeAttrs(rawAttrs: string, allowed: string[]): string {
  if (!allowed.length) return '';
  const kept: string[] = [];
  const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(rawAttrs)) !== null) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if ((name === 'href' || name === 'src') && DANGEROUS_URI.test(value)) continue;
    kept.push(`${name}="${escapeAttr(value)}"`);
  }
  return kept.length ? ` ${kept.join(' ')}` : '';
}

// Pure function: sanitize a single HTML string against the tag/attribute allow-list.
export function sanitizeHtml(input: string): string {
  let out = input;
  // 1. Drop dangerous blocks with their content, then any leftover open/void forms.
  out = out.replace(new RegExp(`<\\s*(${BLOCK_TAGS})[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'), '');
  out = out.replace(new RegExp(`<\\s*/?\\s*(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '');
  // 2. Rewrite every remaining tag: keep whitelisted ones (with clean attrs), drop the rest.
  out = out.replace(
    /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (_match, slash: string, rawName: string, attrs: string) => {
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return '';
      if (slash === '/') return VOID_TAGS.has(name) ? '' : `</${name}>`;
      const clean = sanitizeAttrs(attrs, ALLOWED_ATTRS[name] ?? []);
      return VOID_TAGS.has(name) ? `<${name}${clean} />` : `<${name}${clean}>`;
    },
  );
  // 3. Defense-in-depth: strip any surviving on* handlers or javascript: URIs.
  out = out
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, '$1=$2#');
  return out;
}

// Walks a JSON value and sanitizes every string it contains (object keys are left
// untouched). Used on content bodies before they are snapshotted to a version.
export function sanitizeContentBody(body: unknown): unknown {
  if (typeof body === 'string') return sanitizeHtml(body);
  if (Array.isArray(body)) return body.map((item) => sanitizeContentBody(item));
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      out[key] = sanitizeContentBody(value);
    }
    return out;
  }
  return body;
}
