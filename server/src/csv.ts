/**
 * One CSV cell: always quoted, and with spreadsheet formula injection neutralised. A value starting
 * with = + - @ tab or carriage return is prefixed with an apostrophe so Excel or LibreOffice treats
 * it as text (OWASP "CSV injection"). Dates are written as ISO 8601.
 */
export function csvCell(v: unknown): string {
  const t = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
}
