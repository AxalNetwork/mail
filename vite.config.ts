import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // `npm run dev:api` serves the Worker on 8787; the dev server forwards /api to it.
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    exclude: ['node_modules/**', 'dist/**']
  }
});
