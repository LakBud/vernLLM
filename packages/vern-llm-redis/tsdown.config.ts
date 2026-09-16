import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/circuitBreaker.ts',
    'src/rateLimit.ts',
    'src/cache.ts',
    'src/clients/ioredis.ts',
    'src/clients/nodeRedis.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  publint: true,
  unused: true,

  // vern-llm is a peer dependency: the consumer's own copy satisfies it
  // at runtime, so it must never be bundled into this package's output.
  deps: {
    neverBundle: ['vern-llm'],
  },
});
