import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env.GAME_SERVER_PORT || 8080);

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      '/api': { target: `http://localhost:${SERVER_PORT}` },
    },
    fs: { allow: ['..'] },
  },
  preview: { port: 4173 },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
