// Packs this package and vern-llm, installs them into a throwaway consumer, then runs one call
// through both ESM and CJS. The consumer's own vern-llm copy must be the only one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-logger-smoke-'));

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
  const loggerTarball = pack(packageRoot);
  const vernLLMTarball = pack(path.join(packageRoot, '..', '..', 'vern-llm'));

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'vern-llm-logger-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  execFileSync('npm', ['install', '--no-save', vernLLMTarball, loggerTarball], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // The manifest that shipped, not the workspace one.
  const installed = JSON.parse(
    readFileSync(path.join(consumerDir, 'node_modules', 'vern-llm-logger', 'package.json'), 'utf8'),
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
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
        },
      },
    };
  `;

  // Shared by both module systems: the same call, the same assertions.
  const callAndCheck = (label: string) => `
    const sink = logger.memorySink();
    const middleware = logger.loggerMiddleware({ sink, logger: 'silent' });
    const llm = new vern.VernLLM({ client, model: 'gpt-4o', logger: 'silent', middleware: [middleware] });
    const answer = await llm.call({ userContent: 'hi', jsonMode: false });

    assert.equal(answer, 'ok', '${label}: the call result changed');
    assert.equal(sink.entries.length, 1, '${label}: expected exactly one record');
    const record = sink.entries[0].entry;
    assert.equal(record.kind, 'call');
    assert.equal(record.outcome, 'ok', '${label}: wrong outcome');
    assert.equal(record.provider, 'primary');
    assert.equal(record.attempts, 1);
    assert.equal(record.usage.totalTokens, 7);
    assert.equal(JSON.parse(JSON.stringify(record)).path[0].provider, 'primary', '${label}: record is not JSON safe');
    assert.equal(middleware.stats.snapshot().series[0].count, 1, '${label}: stats did not see the call');
    assert.equal(typeof middleware.dispose, 'function', '${label}: dispose missing');
    middleware.dispose();
    assert.equal(middleware.name, 'logger');
    assert.equal(middleware.position, 'outermost');
    assert.equal(typeof logger.jsonSink().write, 'function', '${label}: jsonSink missing');
    assert.equal(typeof logger.fromEvent('a', 'b'), 'function', '${label}: fromEvent missing');
    assert.equal(typeof logger.consoleSink().write, 'function', '${label}: consoleSink missing');
    console.log('${label}: construction and one recorded call ok');
  `;

  const expectedExports = [
    'consoleSink',
    'fromEvent',
    'jsonSink',
    'loggerMiddleware',
    'loggerMiddlewareRef',
    'memorySink',
  ];

  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(
    esmFile,
    `
    import assert from 'node:assert/strict';
    ${harness}

    const logger = await import('vern-llm-logger');
    const vern = await import('vern-llm');

    assert.deepEqual(Object.keys(logger).sort(), ${JSON.stringify(expectedExports)}, 'ESM: unexpected export surface');
    assert.ok(logger.loggerMiddlewareRef, 'ESM: loggerMiddlewareRef missing');
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

      const logger = require('vern-llm-logger');
      const vern = require('vern-llm');

      assert.deepEqual(Object.keys(logger).sort(), ${JSON.stringify(expectedExports)}, 'CJS: unexpected export surface');
      assert.ok(logger.loggerMiddlewareRef, 'CJS: loggerMiddlewareRef missing');
      ${callAndCheck('CJS')}
    })().catch((error) => { console.error(error); process.exit(1); });
  `,
  );
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // The package must not pull a second vern-llm copy in beside the consumer's.
  const nested = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-logger')).includes(
    'node_modules',
  );
  assert.equal(
    nested,
    false,
    'the package installed its own node_modules, so it bundled a dependency',
  );

  // Type declarations for both module systems.
  const shipped = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-logger', 'dist'));
  assert.ok(shipped.includes('index.d.mts'), 'index.d.mts missing from the installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from the installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points, types, peer range, and a recorded call all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
