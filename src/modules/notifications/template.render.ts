// Logic-less template rendering. Only `{{var}}` substitution is supported — no
// conditionals, loops, or expressions — so admin-authored bodies can never execute code
// (no SSTI). Variables are checked against a per-event allow-list and rendering fails
// closed on an unknown or missing variable (docs/10).

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export class TemplateError extends Error {}

export function renderTemplate(
  body: string,
  vars: Record<string, string | number | undefined>,
  allowList: string[],
): string {
  return body.replace(TOKEN, (_m, name: string) => {
    if (!allowList.includes(name)) {
      throw new TemplateError(`Variable "${name}" is not allowed for this event`);
    }
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      throw new TemplateError(`Missing value for "${name}"`);
    }
    return String(value);
  });
}

// Returns every distinct token referenced by a template body.
export function templateVars(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(TOKEN)) found.add(m[1]);
  return [...found];
}

// Validates that a template body only references allowed variables (used on write).
export function assertTemplateVars(body: string, allowList: string[]): void {
  for (const name of templateVars(body)) {
    if (!allowList.includes(name)) {
      throw new TemplateError(`Variable "${name}" is not allowed for this event`);
    }
  }
}

// Minimal server-side HTML sanitization for email bodies: strips <script>/<style>
// blocks, inline event handlers, and javascript: URLs. Logic-less rendering already
// blocks SSTI; this blocks stored XSS in admin-authored HTML (docs/10).
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, '$1=$2#');
}
