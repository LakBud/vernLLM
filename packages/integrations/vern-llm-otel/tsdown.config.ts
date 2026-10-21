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

  // Both are peer dependencies: the consumer's own copies must be the ones in
  // use at runtime, because the OpenTelemetry API relies on a single shared
  // global and vern-llm on a single LLMError class.
  deps: {
    neverBundle: ['vern-llm', '@opentelemetry/api'],
  },
});
