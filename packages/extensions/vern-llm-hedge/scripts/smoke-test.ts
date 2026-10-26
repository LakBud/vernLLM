// Packs this package and vern-llm, installs them into a throwaway consumer, then runs hedged and
// unhedged calls through both ESM and CJS. The consumer's own vern-llm copy must be the only one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-hedge-smoke-'));

function pack(cwd: string): string {
  // `pnpm pack` rewrites `workspace:` ranges into real semver ranges, as publishing does. `npm
  // pack` leaves them alone, and `npm install` then fails on the tarball.
  const output = execFileSync('pnpm', ['pack', '--pack-destination', scratchDir], {
    cwd,
    encoding: 'utf8',
  }).trim();

  // `pnpm pack` prints the full tarball path as its last line.
  const tarball = output.split('\n').pop()?.trim();
  if (!tarball)
    throw new Error(`Could not determine a tarball path from pnpm pack output:\n${output}`);
  return tarball;
}

try {
  const hedgeTarball = pack(packageRoot);
  const vernLLMTarball = pack(path.join(packageRoot, '..', '..', 'vern-llm'));

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'vern-llm-hedge-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  execFileSync('npm', ['install', '--no-save', vernLLMTarball, hedgeTarball], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // The manifest that shipped, not the workspace one.
  const installed = JSON.parse(
    readFileSync(path.join(consumerDir, 'node_modules', 'vern-llm-hedge', 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  const vernRange = installed.peerDependencies?.['vern-llm'];
  assert.ok(vernRange, 'the vern-llm peer dependency is missing from the packed manifest');
  assert.ok(!vernRange.includes('workspace:'), `unresolved workspace range: ${vernRange}`);
  assert.match(
    vernRange,
    /^[\^~>=<]*\d+\.\d+\.\d+/,
    `the vern-llm peer range is not a semver range: ${vernRange}`,
  );
  assert.equal(installed.dependencies, undefined, 'the package must have no runtime dependencies');

  // A client that answers after `ms`, and gives up when the core cancels it, like a provider SDK.
  const harness = `
    const make = (name, ms) => ({
      chat: { completions: { create: (_params, { signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ choices: [{ message: { content: name } }] }), ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      }) } },
    });
  `;

  // Shared by both module systems: the same calls, the same assertions.
  const callAndCheck = (label: string) => `
    const decisions = [];
    const probe = {
      name: 'probe',
      onEvent: (event) => { if (event.kind === 'custom' && event.name === pkg.HEDGE_DECISION_EVENT) decisions.push(event.data); },
    };
    const build = (primaryMs) => new vern.VernLLM({
      client: make('primary', primaryMs), model: 'm', name: 'primary', logger: 'silent', maxRetries: 0,
      fallback: [{ client: make('b', 0), model: 'mb', name: 'b' }],
      middleware: [probe, pkg.hedgeMiddleware({ delay: 40, budget: { ratio: 1, burst: 1 }, logger: 'silent' })],
    });
    const params = { userContent: 'hi', jsonMode: false };

    assert.equal(await build(5_000).call(params), 'b', '${label}: the slow first target was not hedged');
    assert.equal(await build(0).call(params), 'primary', '${label}: a fast first target changed');
    assert.deepEqual(decisions.map((d) => d.outcome), ['won', 'not_needed'], '${label}: wrong decisions');
    assert.equal(decisions[0].target, 'b');

    const hedge = pkg.hedgeMiddleware({ delay: 40 });
    assert.equal(hedge.name, 'hedge');
    assert.equal(hedge.position, 10);
    assert.equal(hedge.reruns, true);
    assert.deepEqual(pkg.promptSizeDimension({ usage: { promptTokens: 5_000 } }), 'm', '${label}: promptSizeDimension wrong');
    assert.equal(pkg.hedgeDimension({ custom: { 'hedge.decision': decisions } }), 'not_needed', '${label}: hedgeDimension wrong');
    assert.throws(() => pkg.hedgeMiddleware(), /hedgeMiddleware: stats must have a quantile function/, '${label}: options not validated');
    console.log('${label}: a hedged call, an unhedged call, the dimensions and option validation ok');
  `;

  const expectedExports = [
    'HEDGE_ADAPT_EVENT',
    'HEDGE_DECISION_EVENT',
    'hedgeDimension',
    'hedgeLogFields',
    'hedgeMiddleware',
    'hedgeMiddlewareRef',
    'nextTargets',
    'promptSizeDimension',
  ];

  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(
    esmFile,
    `
    import assert from 'node:assert/strict';
    ${harness}

    const pkg = await import('vern-llm-hedge');
    const vern = await import('vern-llm');

    assert.deepEqual(Object.keys(pkg).sort(), ${JSON.stringify(expectedExports)}, 'ESM: unexpected export surface');
    ${callAndCheck('ESM')}
  `,
  );
  execFileSync('node', [esmFile], { cwd: consumerDir, stdio: 'inherit' });

  const cjsFile = path.join(consumerDir, 'cjs-check.cjs');
  writeFileSync(
    cjsFile,
    `
    (async () => {
      const assert = require('node:assert/strict');
      ${harness}

      const pkg = require('vern-llm-hedge');
      const vern = require('vern-llm');

      assert.deepEqual(Object.keys(pkg).sort(), ${JSON.stringify(expectedExports)}, 'CJS: unexpected export surface');
      ${callAndCheck('CJS')}
    })().catch((error) => { console.error(error); process.exit(1); });
  `,
  );
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // The package must not pull a second vern-llm copy in beside the consumer's.
  const nested = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-hedge')).includes(
    'node_modules',
  );
  assert.equal(
    nested,
    false,
    'the package installed its own node_modules, so it bundled a dependency',
  );

  // Type declarations for both module systems.
  const shipped = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-hedge', 'dist'));
  assert.ok(shipped.includes('index.d.mts'), 'index.d.mts missing from the installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from the installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points, types, peer range, and a hedged and an unhedged call all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
