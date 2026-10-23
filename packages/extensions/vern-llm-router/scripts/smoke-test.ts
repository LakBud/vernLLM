// Packs this package and vern-llm, installs them into a throwaway consumer, then runs one call
// through both ESM and CJS. The consumer's own vern-llm copy must be the only one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-router-smoke-'));

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
  const routerTarball = pack(packageRoot);
  const vernLLMTarball = pack(path.join(packageRoot, '..', '..', 'vern-llm'));

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'vern-llm-router-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  execFileSync('npm', ['install', '--no-save', vernLLMTarball, routerTarball], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // The manifest that shipped, not the workspace one.
  const installed = JSON.parse(
    readFileSync(path.join(consumerDir, 'node_modules', 'vern-llm-router', 'package.json'), 'utf8'),
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

  const harness = `
    const make = (name) => ({
      chat: { completions: { create: async () => ({ choices: [{ message: { content: name } }] }) } },
    });
  `;

  // Shared by both module systems: the same calls, the same assertions.
  const callAndCheck = (label: string) => `
    const decisions = [];
    const router = pkg.routerMiddleware({
      routes: [{ name: 'bulk', when: { context: { tier: 'free' } }, targets: ['b'] }],
      logger: 'silent',
      health: () => llm,
    });
    const probe = {
      name: 'probe',
      onEvent: (event) => { if (event.kind === 'custom' && event.name === 'router.decision') decisions.push(event.data); },
    };
    const llm = new vern.VernLLM({
      client: make('primary'), model: 'm', name: 'primary', logger: 'silent', maxRetries: 0,
      fallback: [{ client: make('b'), model: 'mb', name: 'b' }],
      middleware: [probe, router],
    });
    const params = { userContent: 'hi', jsonMode: false };

    assert.equal(await llm.call({ ...params, context: { tier: 'free' } }), 'b', '${label}: route not applied');
    assert.equal(await llm.call(params), 'primary', '${label}: unrouted call changed');
    assert.equal(await llm.call({ ...params, context: { tier: 'free' }, targets: ['primary'] }), 'primary', '${label}: pinned order changed');
    assert.deepEqual(decisions.map((d) => [d.route ?? null, d.strategy, d.applied]), [
      ['bulk', 'ordered', true], [null, 'ordered', true], [null, 'pinned', false],
    ], '${label}: wrong decisions');
    assert.equal(router.name, 'router');
    assert.equal(router.position, 0);
    assert.equal(typeof pkg.routerRouteKey, 'object', '${label}: routerRouteKey missing');
    assert.deepEqual(router.preview({ request: { model: 'm', max_tokens: 10, messages: [] } }).order, ['primary', 'b'], '${label}: preview wrong');
    console.log('${label}: construction, a routed call, an unrouted call and a pinned call ok');
  `;

  const expectedExports = [
    'ROUTER_DECISION_EVENT',
    'driftDimension',
    'routeDimension',
    'routerMiddleware',
    'routerMiddlewareRef',
    'routerRouteKey',
  ];

  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(
    esmFile,
    `
    import assert from 'node:assert/strict';
    ${harness}

    const pkg = await import('vern-llm-router');
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

      const pkg = require('vern-llm-router');
      const vern = require('vern-llm');

      assert.deepEqual(Object.keys(pkg).sort(), ${JSON.stringify(expectedExports)}, 'CJS: unexpected export surface');
      ${callAndCheck('CJS')}
    })().catch((error) => { console.error(error); process.exit(1); });
  `,
  );
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // The package must not pull a second vern-llm copy in beside the consumer's.
  const nested = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-router')).includes(
    'node_modules',
  );
  assert.equal(
    nested,
    false,
    'the package installed its own node_modules, so it bundled a dependency',
  );

  // Type declarations for both module systems.
  const shipped = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-router', 'dist'));
  assert.ok(shipped.includes('index.d.mts'), 'index.d.mts missing from the installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from the installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points, types, peer range, and a routed call and a pinned call all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
