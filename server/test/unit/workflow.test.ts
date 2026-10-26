import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASE_STATUSES, TRANSITIONS, canTransition } from '../../src/authz/workflow.js';

describe('case workflow', () => {
  it('cannot jump from draft straight to approved or published', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('draft', 'published')).toBe(false);
    expect(canTransition('under_review', 'published')).toBe(false);
  });

  it('lets a returned case be corrected and resubmitted', () => {
    expect(canTransition('returned', 'validating')).toBe(true);
  });

  it('treats published, rejected and withdrawn as closed', () => {
    for (const s of ['published', 'rejected', 'withdrawn'] as const) expect(TRANSITIONS[s]).toEqual([]);
  });

  it('matches the transition list enforced by the database trigger', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../db/migrations/001_core.sql', import.meta.url)), 'utf8');
    const block = /\(OLD\.status, NEW\.status\) NOT IN \(([\s\S]*?)\)\s*THEN/.exec(sql)?.[1];
    expect(block).toBeTruthy();
    const fromSql = [...block!.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}->${m[2]}`).sort();
    const fromTs = CASE_STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => `${from}->${to}`)).sort();
    expect(fromSql).toEqual(fromTs);
  });
});
