import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Build output goes into the Express static directory
  build: {
    outDir: '../public',
    emptyOutDir: false, // keep api-docs.html and other static files
  },
  server: {
    port: 5173,
    proxy: {
      '/rpc': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/files': 'http://localhost:3000',
      '/exports': 'http://localhost:3000',
    },
  },
});