// Lints the API, the web app and the browser walkthroughs. Run with `npm run lint`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'server/storage/**', 'e2e/shots/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused values are mistakes, except deliberately ignored ones written as _name.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Typing debt in the older staff pages, not a defect: reported, and to be reduced over time.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['server/**/*.ts', 'e2e/**/*.mjs', '*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['e2e/**/*.mjs'],
    // Walkthrough scripts evaluate code inside the browser page.
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
