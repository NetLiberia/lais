// Writes docs/permission-matrix.md from the enforced policy. Run with `npm run docs:permissions`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPermissionMatrix } from '../src/authz/matrixDoc.js';

const target = fileURLToPath(new URL('../../docs/permission-matrix.md', import.meta.url));
mkdirSync(fileURLToPath(new URL('../../docs/', import.meta.url)), { recursive: true });
writeFileSync(target, renderPermissionMatrix());
console.log(`wrote ${target}`);
