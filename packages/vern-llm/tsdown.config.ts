import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/adapters/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  publint: true,
  unused: true,

  external: ['@anthropic-ai/sdk', '@google/genai', 'groq-sdk', 'openai'],
});
