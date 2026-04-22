import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    globals: true,
  },
  plugins: [react()],
  build: {
    outDir: 'build', // output to 'build' instead of 'dist' to match the electron expectations
    emptyOutDir: false, // Keep electron dist files if they share a directory, though react goes to build/
    chunkSizeWarningLimit: 1000, // Increase warning limit to 1MB since this is a local Electron app
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        importExport: resolve(__dirname, 'import-export.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
  },
  base: './', // Use relative paths to make file:// URLs work in production
});
