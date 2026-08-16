// Verifies the actual built output a consumer installs works, not the src
// files the unit/integration suites import from. Run after `pnpm run build`.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ESM entry point
const esm = await import('../dist/index.js');
assert.equal(typeof esm.VernLLM, 'function', 'ESM: VernLLM export missing');
assert.equal(typeof esm.LLMError, 'function', 'ESM: LLMError export missing');
assert.equal(typeof esm.ConsoleLogger, 'function', 'ESM: ConsoleLogger export missing');

// CJS entry point
const cjs = require('../dist/index.cjs');
assert.equal(typeof cjs.VernLLM, 'function', 'CJS: VernLLM export missing');
assert.equal(typeof cjs.LLMError, 'function', 'CJS: LLMError export missing');
assert.equal(typeof cjs.ConsoleLogger, 'function', 'CJS: ConsoleLogger export missing');

// Type declaration files exist for both module systems
require.resolve('../dist/index.d.ts');
require.resolve('../dist/index.d.cts');

// A VernLLM instance actually constructs from the built output
const llm = new esm.VernLLM({
  client: { chat: { completions: { create: async () => ({}) } } },
  model: 'smoke-test-model',
});
assert.ok(llm, 'VernLLM failed to construct from built ESM output');

console.log('smoke test passed: ESM and CJS entry points, types, and construction all work');
