// Verifies the actual published package boundary works: packs this package and vern-llm the way
// they would be published, installs the tarballs into a throwaway consumer alongside the lowest
// @opentelemetry/api this package declares support for, then imports it by package name through
// both ESM and CJS and runs one call end to end.
//
// Both peers are installed for real and resolved from the consumer's own node_modules, which is
// the situation that matters: this package must use the consumer's copy of @opentelemetry/api
// (the API keeps its state in a shared global) and of vern-llm (its errors and middleware
// contracts are checked by shape, and a bundled second copy would defeat that).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-otel-smoke-'));

// The lowest API release the peer range allows, so a feature this package started to rely on
// from a later release fails here instead of in a consumer's app.
const LOWEST_API = '1.9.0';

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
  const otelTarball = pack(packageRoot);
  const vernLLMTarball = pack(path.join(packageRoot, '..', 'vern-llm'));

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'vern-llm-otel-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  execFileSync(
    'npm',
    ['install', '--no-save', vernLLMTarball, otelTarball, `@opentelemetry/api@${LOWEST_API}`],
    { cwd: consumerDir, stdio: 'inherit' },
  );

  // The manifest that shipped, not the workspace one.
  const installed = JSON.parse(
    readFileSync(path.join(consumerDir, 'node_modules', 'vern-llm-otel', 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  const semverRange = /^[\^~>=<]*\d+\.\d+\.\d+/;
  const vernRange = installed.peerDependencies?.['vern-llm'];
  const apiRange = installed.peerDependencies?.['@opentelemetry/api'];

  assert.ok(vernRange, 'the vern-llm peer dependency is missing from the packed manifest');
  assert.ok(!vernRange.includes('workspace:'), `unresolved workspace range: ${vernRange}`);
  assert.match(
    vernRange,
    semverRange,
    `the vern-llm peer range is not a semver range: ${vernRange}`,
  );
  assert.match(
    apiRange ?? '',
    semverRange,
    `the @opentelemetry/api peer range is not semver: ${apiRange}`,
  );
  assert.equal(installed.dependencies, undefined, 'the package must have no runtime dependencies');

  // A minimal recording tracer and meter, so no SDK has to be installed: the API only needs
  // something to hand spans and instruments back, and parenting goes through the real API.
  const harness = `
    const api = require('@opentelemetry/api');

    function createTracer() {
      const spans = [];
      const tracer = {
        startSpan(name, options, ctx) {
          const parent = api.trace.getSpan(ctx ?? api.context.active());
          const record = { name, kind: options?.kind, parent, attributes: { ...options?.attributes }, ended: false };
          spans.push(record);
          const span = {
            record,
            spanContext: () => ({ traceId: '0'.repeat(32), spanId: String(spans.length).padStart(16, '0'), traceFlags: 1 }),
            isRecording: () => true,
            setAttribute(key, value) { record.attributes[key] = value; return span; },
            setAttributes(values) { Object.assign(record.attributes, values); return span; },
            addEvent() { return span; },
            setStatus(status) { record.status = status; return span; },
            updateName() { return span; },
            recordException() {},
            end() { record.ended = true; },
          };
          return span;
        },
      };
      return { tracer, spans };
    }

    function createMeter() {
      const recorded = {};
      const note = (name) => (value) => { (recorded[name] ??= []).push(value); };
      const meter = {
        createHistogram: (name) => ({ record: note(name) }),
        createCounter: (name) => ({ add: note(name) }),
      };
      return { meter, recorded };
    }

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
    const { tracer, spans } = createTracer();
    const { meter, recorded } = createMeter();
    const middleware = otel.otelMiddleware({
      tracer,
      meter,
      logger: 'silent',
      providerNames: { primary: 'openai' },
    });

    const llm = new vern.VernLLM({ client, model: 'gpt-4o', logger: 'silent', middleware: [middleware] });
    const answer = await llm.call({ userContent: 'hi', jsonMode: false });

    assert.equal(answer, 'ok', '${label}: the call result changed');
    assert.equal(spans.length, 2, '${label}: expected one call span and one attempt span');

    const [callSpan, attempt] = spans;
    assert.equal(callSpan.name, 'vernllm.call');
    assert.equal(callSpan.parent, undefined);
    assert.equal(attempt.name, 'chat gpt-4o');
    assert.equal(attempt.parent?.record, callSpan, '${label}: the attempt is not a child of the call span');
    assert.equal(attempt.attributes['gen_ai.provider.name'], 'openai');
    assert.equal(attempt.attributes['gen_ai.usage.input_tokens'], 3);
    assert.equal(attempt.attributes['gen_ai.usage.output_tokens'], 4);
    assert.ok(spans.every((span) => span.ended), '${label}: a span was left open');
    assert.ok(recorded['gen_ai.client.operation.duration']?.length === 1, '${label}: no duration recorded');
    assert.ok(recorded['gen_ai.client.token.usage']?.length === 2, '${label}: no token usage recorded');
    console.log('${label}: one call span, one attempt span, and metrics ok');
  `;

  const expectedExports = ['otelMiddleware', 'otelMiddlewareRef'];

  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(
    esmFile,
    `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    ${harness}

    const otel = await import('vern-llm-otel');
    const vern = await import('vern-llm');

    assert.deepEqual(Object.keys(otel).sort(), ${JSON.stringify(expectedExports)}, 'ESM: unexpected export surface');
    assert.equal(typeof otel.otelMiddleware, 'function', 'ESM: otelMiddleware missing');
    assert.ok(otel.otelMiddlewareRef, 'ESM: otelMiddlewareRef missing');
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

      const otel = require('vern-llm-otel');
      const vern = require('vern-llm');

      assert.deepEqual(Object.keys(otel).sort(), ${JSON.stringify(expectedExports)}, 'CJS: unexpected export surface');
      assert.equal(typeof otel.otelMiddleware, 'function', 'CJS: otelMiddleware missing');
      assert.ok(otel.otelMiddlewareRef, 'CJS: otelMiddlewareRef missing');
      ${callAndCheck('CJS')}
    })().catch((error) => { console.error(error); process.exit(1); });
  `,
  );
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // The one API copy: the package must not have pulled a second one in beside the consumer's.
  const nested = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-otel')).includes(
    'node_modules',
  );
  assert.equal(
    nested,
    false,
    'the package installed its own node_modules, so it bundled a dependency',
  );

  // Type declarations for both module systems.
  const shipped = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-otel', 'dist'));
  assert.ok(shipped.includes('index.d.mts'), 'index.d.mts missing from the installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from the installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points, types, peer ranges, and one traced call all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
