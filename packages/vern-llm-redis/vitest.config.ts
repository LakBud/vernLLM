import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.unit.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/**/*.int.test.ts'],
          environment: 'node',
          testTimeout: 15_000,
          // Most integration tests wait on real Redis cooldowns and leases, so a
          // file finishes as soon as its slowest concurrent test does. The default
          // of 5 would split a big file into batches.
          maxConcurrency: 20,
        },
      },
    ],
  },
});
