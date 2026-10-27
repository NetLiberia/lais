import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests: React components rendered in jsdom with Testing Library. Run with `npm test -w web`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
