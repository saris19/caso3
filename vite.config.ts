import { defineConfig, Plugin } from 'vite';

const coopCoepHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const coopPlugin: Plugin = {
  name: 'coop-coep-headers',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [k, v] of Object.entries(coopCoepHeaders)) res.setHeader(k, v);
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [k, v] of Object.entries(coopCoepHeaders)) res.setHeader(k, v);
      next();
    });
  },
};

export default defineConfig({
  plugins: [coopPlugin],
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  worker: {
    format: 'es',
    plugins: [coopPlugin],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
