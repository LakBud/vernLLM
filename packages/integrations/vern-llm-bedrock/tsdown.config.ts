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
  // use at runtime, because vern-llm relies on a single LLMError class and the
  // AWS SDK commands must match the client the caller constructed.
  deps: {
    neverBundle: ['vern-llm', '@aws-sdk/client-bedrock-runtime'],
  },
});
