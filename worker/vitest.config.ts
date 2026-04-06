import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/utils/**/*.ts', 'src/auth/**/*.ts'],
    },
  },
});
