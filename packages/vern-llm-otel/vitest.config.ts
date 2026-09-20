import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      // The source and the shared test helpers. The entrypoint is pure re-exports with nothing
      // to execute, and it is ignored by Codecov for the same reason.
      include: ['src/**/*.ts', 'tests/helpers.ts'],
      exclude: ['src/index.ts'],
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
        },
      },
    ],
  },
});
