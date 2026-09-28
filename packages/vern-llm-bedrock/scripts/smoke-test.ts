// Verifies the actual published package boundary works: packs this package and vern-llm the way
// they would be published, installs the tarballs into a throwaway consumer alongside the lowest
// @aws-sdk/client-bedrock-runtime this package declares support for, then imports it by package
// name through both ESM and CJS and runs one call end to end against a stubbed `send`.
//
// Both peers are installed for real and resolved from the consumer's own node_modules, which is
// the situation that matters: this package must use the consumer's copy of vern-llm (a bundled
// second copy would split LLMError) and of the AWS SDK (its commands must match the client the
// consumer constructed).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-bedrock-smoke-'));

// The lowest SDK release the peer range allows, so a feature this package started to rely on
// from a later release fails here instead of in a consumer's app.
const LOWEST_SDK = '3.1136.0';

function pack(cwd: string): string {
  // `pnpm pack` rewrites `workspace:` ranges into real semver ranges, as publishing does.
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
  const bedrockTarball = pack(packageRoot);
  const vernLLMTarball = pack(path.join(packageRoot, '..', 'vern-llm'));

  const consumerDir = path.join(scratchDir, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'vern-llm-bedrock-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  execFileSync(
    'npm',
    [
      'install',
      '--no-save',
      vernLLMTarball,
      bedrockTarball,
      `@aws-sdk/client-bedrock-runtime@${LOWEST_SDK}`,
    ],
    { cwd: consumerDir, stdio: 'inherit' },
  );

  // The manifest that shipped, not the workspace one.
  const installed = JSON.parse(
    readFileSync(
      path.join(consumerDir, 'node_modules', 'vern-llm-bedrock', 'package.json'),
      'utf8',
    ),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  const semverRange = /^[\^~>=<]*\d+\.\d+\.\d+/;
  const vernRange = installed.peerDependencies?.['vern-llm'];
  const sdkRange = installed.peerDependencies?.['@aws-sdk/client-bedrock-runtime'];

  assert.ok(vernRange, 'the vern-llm peer dependency is missing from the packed manifest');
  assert.ok(!vernRange.includes('workspace:'), `unresolved workspace range: ${vernRange}`);
  assert.match(vernRange, semverRange, `the vern-llm peer range is not semver: ${vernRange}`);
  assert.match(sdkRange ?? '', semverRange, `the AWS SDK peer range is not semver: ${sdkRange}`);
  assert.equal(installed.dependencies, undefined, 'the package must have no runtime dependencies');

  // Shared by both module systems: the same call, the same assertions.
  const callAndCheck = (label: string) => `
    const client = new sdk.BedrockRuntimeClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const sent = [];
    client.send = async (command) => {
      sent.push(command);
      return {
        output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      };
    };

    const llm = new vern.VernLLM({
      client: bedrock.fromBedrock(client),
      model: 'anthropic.claude-test',
      logger: 'silent',
    });
    const answer = await llm.call({ userContent: 'hi', jsonMode: false });

    assert.equal(answer, 'ok', '${label}: the call result changed');
    assert.ok(sent[0] instanceof sdk.ConverseCommand, '${label}: expected a ConverseCommand from the consumer SDK');

    const bad = await llm
      .call({ userContent: 'hi', jsonMode: true })
      .catch((error) => error);
    assert.ok(bad instanceof vern.LLMError, '${label}: adapter errors must be the consumer LLMError');
    console.log('${label}: one call through the installed package ok');
  `;

  const expectedExports = ['fromBedrock'];

  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(
    esmFile,
    `
    import assert from 'node:assert/strict';

    const bedrock = await import('vern-llm-bedrock');
    const vern = await import('vern-llm');
    const sdk = await import('@aws-sdk/client-bedrock-runtime');

    assert.deepEqual(Object.keys(bedrock).sort(), ${JSON.stringify(expectedExports)}, 'ESM: unexpected export surface');
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

      const bedrock = require('vern-llm-bedrock');
      const vern = require('vern-llm');
      const sdk = require('@aws-sdk/client-bedrock-runtime');

      assert.deepEqual(Object.keys(bedrock).sort(), ${JSON.stringify(expectedExports)}, 'CJS: unexpected export surface');
      ${callAndCheck('CJS')}
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `,
  );
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  const shipped = readdirSync(path.join(consumerDir, 'node_modules', 'vern-llm-bedrock', 'dist'));
  for (const file of ['index.mjs', 'index.cjs', 'index.d.mts', 'index.d.cts']) {
    assert.ok(shipped.includes(file), `${file} missing from the installed package`);
  }

  console.log('smoke test passed: installed ESM and CJS entry points, types, and a call all work');
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
