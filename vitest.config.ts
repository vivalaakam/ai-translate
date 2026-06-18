import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup.js'],
    // DB tests share a global pg Pool; parallel files can close each other's pool.
    fileParallelism: false,
  },
});