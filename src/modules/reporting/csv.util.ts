// Minimal, dependency-free CSV encoder for report exports (docs/13). A field that
// contains a comma, double-quote, CR or LF is wrapped in double quotes with any
// embedded quotes doubled (RFC 4180); everything else is emitted verbatim. Rows
// carry aggregates only — callers never pass raw customer PII through here.
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(escape).join(',');
  const body = rows.map((row) => columns.map((c) => escape(row[c])).join(','));
  return [header, ...body].join('\r\n');
}
