import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  publint: true,
  unused: true,

  // vern-llm is a peer dependency: the consumer's own copy must be the one in use at runtime,
  // because errors and middleware contracts are checked against a single vern-llm.
  deps: {
    neverBundle: ['vern-llm'],
  },
});
