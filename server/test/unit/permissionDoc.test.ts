import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPermissionMatrix } from '../../src/authz/matrixDoc.js';

describe('docs/permission-matrix.md', () => {
  it('matches the policy the server enforces (regenerate with npm run docs:permissions)', () => {
    const committed = readFileSync(fileURLToPath(new URL('../../../docs/permission-matrix.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderPermissionMatrix());
  });
});
