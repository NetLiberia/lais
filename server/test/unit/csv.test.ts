import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/csv.js';

describe('csvCell', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('Musu "M" Testperson')).toBe('"Musu ""M"" Testperson"');
    expect(csvCell(null)).toBe('""');
  });

  it('neutralises values a spreadsheet would run as formulas', () => {
    for (const v of ['=HYPERLINK("x")', '+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(csvCell(v).startsWith(`"'`)).toBe(true);
    }
    expect(csvCell('Gbarnga')).toBe('"Gbarnga"');
  });

  it('writes dates as ISO 8601', () => {
    expect(csvCell(new Date('2026-10-27T07:00:00Z'))).toBe('"2026-10-27T07:00:00.000Z"');
  });
});
