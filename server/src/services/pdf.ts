/**
 * A minimal PDF writer for tabular reports: A4 landscape, Helvetica, text only. It exists so reports can
 * be downloaded as PDF without a browser or a native dependency. Text is limited to the WinAnsi range;
 * other characters are replaced, and long cells are cut to their column width.
 */

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 36;
const LINE = 11;

function ansi(text: string): string {
  return text
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/²/g, '2')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Approximate Helvetica width (average glyph 0.5 em) used to fit cells. */
const fit = (text: string, width: number, size: number) => {
  const max = Math.max(1, Math.floor(width / (size * 0.5)));
  return text.length > max ? `${text.slice(0, max - 1)}~` : text;
};

export interface PdfTable {
  title: string;
  meta: string[];
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
}

export function tablePdf(t: PdfTable): Buffer {
  const cell = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : String(v));
  const usable = PAGE_W - 2 * MARGIN;
  // Column widths in proportion to their longest content (bounded), so short codes take less room.
  const weights = t.columns.map((c) => Math.min(40, Math.max(6, c.label.length, ...t.rows.slice(0, 200).map((r) => cell(r[c.key]).length))));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * usable);

  const pages: string[] = [];
  let ops: string[] = [];
  let y = 0;
  const text = (x: number, yy: number, s: string, size: number, bold = false) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${ansi(s)}) Tj ET`);
  const header = () => {
    let x = MARGIN;
    t.columns.forEach((c, i) => { text(x, y, fit(c.label, widths[i] - 4, 8), 8, true); x += widths[i]; });
    ops.push(`${MARGIN} ${(y - 3).toFixed(1)} m ${PAGE_W - MARGIN} ${(y - 3).toFixed(1)} l S`);
    y -= LINE + 2;
  };
  const newPage = (first: boolean) => {
    if (ops.length) pages.push(ops.join('\n'));
    ops = ['0.5 w'];
    y = PAGE_H - MARGIN;
    if (first) {
      text(MARGIN, y, t.title, 14, true); y -= 18;
      for (const m of t.meta) { text(MARGIN, y, fit(m, usable, 8), 8); y -= LINE; }
      y -= 6;
    }
    header();
  };
  newPage(true);
  if (t.rows.length === 0) { text(MARGIN, y, 'No records match the filters.', 9); }
  for (const r of t.rows) {
    if (y < MARGIN + LINE) newPage(false);
    let x = MARGIN;
    t.columns.forEach((c, i) => { text(x, y, fit(cell(r[c.key]), widths[i] - 4, 8), 8); x += widths[i]; });
    y -= LINE;
  }
  pages.push(ops.join('\n'));

  // Objects: 1 catalog, 2 pages, 3-4 fonts, then a page and a content stream per page.
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((content, i) => {
    const pageNo = 5 + i * 2;
    const footer = `BT /F1 7 Tf ${MARGIN} 20 Td (${ansi(`${t.title} - page ${i + 1} of ${pages.length}`)}) Tj ET`;
    const stream = `${content}\n${footer}`;
    objects[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageNo + 1} 0 R >>`;
    objects[pageNo + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
