import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  // Loaded from disk by Electron, so one larger bundle (Markdown + highlight.js) is fine.
  build: { outDir: '../../out/renderer', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { port: 5199, strictPort: true },
});
