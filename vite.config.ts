import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * dist/build-config.json: the OAuth client ID from the build environment, for
 * deployments that set GOOGLE_CLIENT_ID as a build variable (e.g. Cloudflare
 * Workers Builds) rather than on the Worker. The Worker falls back to it.
 */
function buildConfig(): Plugin {
  return {
    name: 'axal-build-config',
    apply: 'build',
    generateBundle() {
      const googleClientId = (process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim();
      this.emitFile({ type: 'asset', fileName: 'build-config.json', source: JSON.stringify({ googleClientId }) });
    }
  };
}

export default defineConfig({
  plugins: [react(), buildConfig()],
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
