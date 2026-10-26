import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the Express API so cookies stay same-origin (SameSite=Strict).
// Set LAIS_API_URL if the API runs on another port (match PORT in server/.env).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.LAIS_API_URL ?? 'http://localhost:4000' },
  },
});
