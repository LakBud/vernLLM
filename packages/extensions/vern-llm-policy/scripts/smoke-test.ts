// Packs this package and vern-llm, installs them into a throwaway consumer, then runs one call
// through both ESM and CJS. The consumer's own vern-llm copy must be the only one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-policy-smoke-'));

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
  const policyTarball = pack(packageRoot);
  const vernLLMTarball = pack(path.join(packageRoot, '..', '..', 'vern-llm'));

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'vern-llm-policy-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  execFileSync('npm', ['install', '--no-save', vernLLMTarball, policyTarball], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // The manifest that shipped, not the workspace one.
  const installed = JSON.parse(
    readFileSync(path.join(consumerDir, 'node_modules', 'vern-llm-policy', 'package.json'), 'utf8'),
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
    const flagsSeen = [];
    const policy = pkg.policyMiddleware({
      logger: 'silent',
      version: 'smoke-1',
      targets: { primary: { region: 'us' }, b: { region: 'eu' } },
      rules: [
        { id: 'eu-only', forbid: { not: { region: 'eu' } }, when: { context: { region: 'eu' } }, set: { duplicateSends: false } },
        { id: 'lockout', forbid: 'all', when: { context: { status: 'suspended' } } },
      ],
    });
    const probe = {
      name: 'probe',
      onEvent: (event) => { if (event.kind === 'custom' && event.name === 'policy.decision') decisions.push(event.data); },
    };
    const inside = {
      name: 'inside',
      position: 0,
      wrap: (request, next, ctx) => { flagsSeen.push({ ...pkg.policyFlags(ctx) }); return next(); },
    };
    const llm = new vern.VernLLM({
      client: make('primary'), model: 'm', name: 'primary', logger: 'silent', maxRetries: 0,
      fallback: [{ client: make('b'), model: 'mb', name: 'b' }],
      middleware: [probe, policy, inside],
    });
    const params = { userContent: 'hi', jsonMode: false };

    assert.equal(await llm.call({ ...params, context: { region: 'eu' } }), 'b', '${label}: target not removed');
    assert.equal(await llm.call(params), 'primary', '${label}: untouched call changed');
    await assert.rejects(
      llm.call({ ...params, context: { status: 'suspended' } }),
      (error) => error.code === 'policy_denied' && error.type === 'invalid_params',
      '${label}: call not denied',
    );
    assert.deepEqual(decisions.map((d) => [d.outcome, d.version]), [
      ['narrowed', 'smoke-1'], ['allowed', 'smoke-1'], ['denied', 'smoke-1'],
    ], '${label}: wrong decisions');
    assert.deepEqual(flagsSeen, [{ duplicateSends: false }, {}], '${label}: flags wrong');
    assert.equal(policy.name, 'policy');
    assert.equal(policy.position, -100);
    assert.equal(pkg.POLICY_DECISION_EVENT, 'policy.decision');

    const ask = { context: { region: 'eu' }, targets: [{ name: 'primary', model: 'm' }, { name: 'b', model: 'mb' }] };
    assert.deepEqual(policy.evaluate(ask).allowed, ['b'], '${label}: evaluate wrong');

    policy.update({ version: 'smoke-2', rules: [] });
    assert.equal(await llm.call({ ...params, context: { region: 'eu' } }), 'primary', '${label}: update not applied');
    assert.throws(() => policy.update({ rules: [{ id: 'x' }] }), /policyMiddleware:/, '${label}: bad update accepted');
    assert.equal(policy.evaluate(ask).version, 'smoke-2', '${label}: bad update replaced the policy');
    console.log('${label}: construction, a narrowed call, an untouched call, a denied call, flags, evaluate and update ok');
  `;

  const expectedExports = [
    'POLICY_CROSS_JOIN_EVENT',
    'POLICY_DECISION_EVENT',
    'policyFlags',
    'policyMiddleware',
    'policyMiddlewareRef',
  ];

  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(
    esmFile,
    `
    import assert from 'node:assert/strict';
    ${harness}

    const pkg = await import('vern-llm-policy');
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

      const pkg = require('vern-llm-policy');
      const vern = require('vern-llm');

      assert.deepEqual(Object.keys(pkg).sort(), ${JSON.stringify(expectedExports)}, 'CJS: unexpected export surface');
      ${callAndCheck('CJS')}
    })().catch((error) => { console.error(error); process.exit(1); });
  `,
  );
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // The package must not pull a second vern-llm copy in beside the consumer's.
  const nested = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-policy')).includes(
    'node_modules',
  );
  assert.equal(
    nested,
    false,
    'the package installed its own node_modules, so it bundled a dependency',
  );

  // Type declarations for both module systems.
  const shipped = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-policy', 'dist'));
  assert.ok(shipped.includes('index.d.mts'), 'index.d.mts missing from the installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from the installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points, types, peer range, and a narrowed call, a denied call, flags, evaluate and update all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
