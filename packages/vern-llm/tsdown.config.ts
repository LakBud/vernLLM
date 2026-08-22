import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,

  external: [
    '@aws-sdk/client-bedrock-runtime',
    '@anthropic-ai/sdk',
    '@google/genai',
    'groq-sdk',
    'openai',
  ],
});
