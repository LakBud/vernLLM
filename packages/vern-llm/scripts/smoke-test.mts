// Verifies the actual published package boundary works: packs the package
// with `pnpm pack`, installs that tarball into a throwaway consumer project,
// then imports it by package name through both ESM and CJS. This exercises
// package.json's `exports`/`files`/`main`/`module`/`types` fields the way a
// real consumer would, unlike importing straight from ../dist, which can
// pass even when those fields are broken or `files` excludes something.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-smoke-'));

try {
  // Pack the package as it would actually be published. Uses `npm pack`
  // rather than `pnpm pack` since npm ships with Node everywhere this
  // script runs, so no extra assumption about the package manager on PATH.
  const packOutput = execFileSync('npm', ['pack', '--pack-destination', scratchDir], {
    cwd: packageRoot,
    encoding: 'utf8',
  }).trim();
  const tarballName: string | undefined = packOutput.split('\n').pop()?.trim();
  if (!tarballName) {
    throw new Error(`Could not determine tarball filename from npm pack output:\n${packOutput}`);
  }
  const tarballPath = path.join(scratchDir, tarballName);

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });

  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'vern-llm-smoke-consumer', private: true, version: '0.0.0' }, null, 2),
  );

  // Install the packed tarball by path, exactly like a real consumer's
  // package.json pointing at a registry tarball would resolve.
  execFileSync('npm', ['install', '--no-save', tarballPath], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // ESM entry point, resolved through the installed package's `exports` map.
  const esmScript = `
    import assert from 'node:assert/strict';
    const esm = await import('vern-llm');
    assert.equal(typeof esm.VernLLM, 'function', 'ESM: VernLLM export missing');
    assert.equal(typeof esm.LLMError, 'function', 'ESM: LLMError export missing');
    assert.equal(typeof esm.ConsoleLogger, 'function', 'ESM: ConsoleLogger export missing');

    const llm = new esm.VernLLM({
      client: { chat: { completions: { create: async () => ({}) } } },
      model: 'smoke-test-model',
    });
    assert.ok(llm, 'VernLLM failed to construct from the installed ESM entry');
    console.log('ESM entry point ok');
  `;
  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(esmFile, esmScript);
  execFileSync('node', [esmFile], { cwd: consumerDir, stdio: 'inherit' });

  // CJS entry point, resolved through the same installed package's `exports` map.
  const cjsScript = `
    const assert = require('node:assert/strict');
    const cjs = require('vern-llm');
    assert.equal(typeof cjs.VernLLM, 'function', 'CJS: VernLLM export missing');
    assert.equal(typeof cjs.LLMError, 'function', 'CJS: LLMError export missing');
    assert.equal(typeof cjs.ConsoleLogger, 'function', 'CJS: ConsoleLogger export missing');

    const llm = new cjs.VernLLM({
      client: { chat: { completions: { create: async () => ({}) } } },
      model: 'smoke-test-model',
    });
    assert.ok(llm, 'VernLLM failed to construct from the installed CJS entry');
    console.log('CJS entry point ok');
  `;
  const cjsFile = path.join(consumerDir, 'cjs-check.cjs');
  writeFileSync(cjsFile, cjsScript);
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // Type declarations actually shipped in the installed package, for both
  // module systems, confirming `files`/`exports.types` include them.
  const installedTypesDir = path.join(consumerDir, 'node_modules', 'vern-llm', 'dist');
  const shipped = readdirSync(installedTypesDir);
  assert.ok(shipped.includes('index.d.ts'), 'index.d.ts missing from installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points, types, and construction all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
