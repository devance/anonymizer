import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * One UI, two builds. `@target` picks what differs (src/target-types.ts):
 *   vite / vite build              the desktop app: ./src/desktop/target.tsx → dist/ (Tauri's frontendDist)
 *   vite --mode web / build:web    the website: ./src/web/target.tsx → dist-web/ (the Worker's assets)
 * `npm run dev` in ../desktop starts the first; `npm run dev:web` proxies /api to `wrangler dev`.
 */
export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  return {
    plugins: [react()],
    clearScreen: false,
    resolve: {
      alias: { '@target': fileURLToPath(new URL(web ? './src/web/target.tsx' : './src/desktop/target.tsx', import.meta.url)) },
    },
    // Web only: the Worker serves these headers with the assets (CSP and friends).
    publicDir: web ? 'public-web' : false,
    server: web
      ? { port: 5174, strictPort: true, proxy: { '/api': 'http://localhost:8787', '/cli/v1': 'http://localhost:8787' } }
      : { port: 5173, strictPort: true },
    build: { target: ['es2022', 'safari17', 'chrome120'], outDir: web ? 'dist-web' : 'dist', emptyOutDir: true },
  };
});
