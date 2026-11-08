import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 7 + React 19 (S11, F4AI-17).
 *
 * `VITE_GATEWAY_URL` prebíja defaultnú adresu gateway
 * (`http://127.0.0.1:18081`) — nastavuje sa v `.env.local` alebo
 * prostredím pri `vite build`. Prefix `VITE_` je štandardný pre Vite,
 * hodnoty sa vkladajú do bundle pri buildu.
 */
export default defineConfig({
  plugins: [react()],
  envPrefix: 'VITE_',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
