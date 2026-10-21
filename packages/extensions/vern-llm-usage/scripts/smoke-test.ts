// Packs this package and vern-llm, installs them into a throwaway consumer, then runs one call
// through both ESM and CJS. The consumer's own vern-llm copy must be the only one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-usage-smoke-'));

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
  const usageTarball = pack(packageRoot);
  const vernLLMTarball = pack(path.join(packageRoot, '..', '..', 'vern-llm'));

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'vern-llm-usage-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  execFileSync('npm', ['install', '--no-save', vernLLMTarball, usageTarball], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // The manifest that shipped, not the workspace one.
  const installed = JSON.parse(
    readFileSync(path.join(consumerDir, 'node_modules', 'vern-llm-usage', 'package.json'), 'utf8'),
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
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
          }),
        },
      },
    };
  `;

  // Shared by both module systems: the same calls, the same assertions. 60 x 2,000 plus
  // 40 x 10,000 nano dollars is $0.00052 at the prices below.
  const callAndCheck = (label: string) => `
    const usage = pkg.usageMiddleware({
      prices: { 'gpt-6-sol': { input: 2, output: 10 } },
      pricesAsOf: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      attribute: ['tenantId'],
      budgets: [{ key: 'tenantId', limitTokens: 120, per: 'day' }],
      logger: 'silent',
    });
    const llm = new vern.VernLLM({
      client, model: 'gpt-6-sol', logger: 'silent', defaultMaxTokens: 50, middleware: [usage],
    });
    const params = { userContent: 'hi', jsonMode: false, context: { tenantId: 'acme' } };

    assert.equal(await llm.call(params), 'ok', '${label}: the call result changed');
    const totals = usage.totals({ tenantId: 'acme' });
    assert.equal(totals.calls, 1, '${label}: totals did not see the call');
    assert.equal(totals.estimatedCostUsd, 0.00052, '${label}: wrong estimated cost');
    assert.equal(totals.bySource.table, 1);

    await assert.rejects(llm.call(params), (error) => {
      assert.equal(error.type, 'quota_exceeded', '${label}: wrong error type');
      assert.equal(error.code, 'budget_exceeded', '${label}: wrong error code');
      return true;
    });
    const [budget] = await usage.remaining({ tenantId: 'acme' });
    assert.equal(budget.spent, 100, '${label}: wrong spent tokens');
    assert.equal(budget.remaining, 20, '${label}: wrong remaining tokens');
    assert.equal(typeof usage.costFor({ name: 'primary', model: 'gpt-6-sol' }, {
      messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
    }), 'number', '${label}: costFor missing');
    assert.equal(usage.name, 'usage');
    assert.equal(usage.position, -50);
    assert.equal(typeof pkg.memoryUsageStore().reserve, 'function', '${label}: memoryUsageStore missing');
    assert.deepEqual(pkg.usageLogFields({ state: { get: () => undefined } }), {});
    console.log('${label}: construction, a priced call, a budget rejection and the reads ok');
  `;

  const expectedExports = [
    'memoryUsageStore',
    'usageLogFields',
    'usageMiddleware',
    'usageMiddlewareRef',
  ];

  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(
    esmFile,
    `
    import assert from 'node:assert/strict';
    ${harness}

    const pkg = await import('vern-llm-usage');
    const vern = await import('vern-llm');

    assert.deepEqual(Object.keys(pkg).sort(), ${JSON.stringify(expectedExports)}, 'ESM: unexpected export surface');
    assert.ok(pkg.usageMiddlewareRef, 'ESM: usageMiddlewareRef missing');
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

      const pkg = require('vern-llm-usage');
      const vern = require('vern-llm');

      assert.deepEqual(Object.keys(pkg).sort(), ${JSON.stringify(expectedExports)}, 'CJS: unexpected export surface');
      assert.ok(pkg.usageMiddlewareRef, 'CJS: usageMiddlewareRef missing');
      ${callAndCheck('CJS')}
    })().catch((error) => { console.error(error); process.exit(1); });
  `,
  );
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // The package must not pull a second vern-llm copy in beside the consumer's.
  const nested = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-usage')).includes(
    'node_modules',
  );
  assert.equal(
    nested,
    false,
    'the package installed its own node_modules, so it bundled a dependency',
  );

  // Type declarations for both module systems.
  const shipped = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-usage', 'dist'));
  assert.ok(shipped.includes('index.d.mts'), 'index.d.mts missing from the installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from the installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points, types, peer range, and a priced call and a budget rejection all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
