// Verifies the actual published package boundary works: packs the package
// with `pnpm pack`, installs that tarball into a throwaway consumer project,
// then imports it by package name through both ESM and CJS, exercising
// every subpath in package.json's `exports` map, not just the main entry.
// This is also the real proof that vern-llm is genuinely zero runtime
// dependency here: the consumer below never installs vern-llm at all, and
// every import still succeeds, since every reference to vern-llm's types
// in this package is `import type`, fully erased at build time.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchDir = mkdtempSync(path.join(tmpdir(), 'vern-llm-redis-smoke-'));

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
    JSON.stringify(
      { name: 'vern-llm-redis-smoke-consumer', private: true, version: '0.0.0' },
      null,
      2,
    ),
  );

  // Install the packed tarball by path, exactly like a real consumer's
  // package.json pointing at a registry tarball would resolve. No vern-llm
  // install here, deliberately, see the header comment above.
  execFileSync('npm', ['install', '--no-save', tarballPath], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // A minimal RedisClient-shaped fake, no real Redis connection needed:
  // this smoke test is about the package boundary (exports, module
  // resolution, construction), not adapter behavior, which the real
  // unit and integration suites already cover.
  const fakeClientSetup = `
    const fakeClient = {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      eval: async () => [0, '0', '0', '-1'],
    };
  `;

  // ESM entry points, resolved through the installed package's exports map.
  const esmScript = `
    import assert from 'node:assert/strict';
    ${fakeClientSetup}

    const main = await import('vern-llm-redis');
    assert.equal(typeof main.redisCache, 'function', 'ESM: redisCache missing from main entry');
    assert.equal(typeof main.redisCircuitBreaker, 'function', 'ESM: redisCircuitBreaker missing from main entry');
    assert.equal(typeof main.redisRateLimit, 'function', 'ESM: redisRateLimit missing from main entry');
    assert.equal(typeof main.fromIoredis, 'function', 'ESM: fromIoredis missing from main entry');
    assert.equal(typeof main.fromNodeRedis, 'function', 'ESM: fromNodeRedis missing from main entry');

    const cb = await import('vern-llm-redis/circuitBreaker');
    assert.equal(typeof cb.redisCircuitBreaker, 'function', 'ESM: circuitBreaker subpath missing its export');
    const rl = await import('vern-llm-redis/rateLimit');
    assert.equal(typeof rl.redisRateLimit, 'function', 'ESM: rateLimit subpath missing its export');
    const cache = await import('vern-llm-redis/cache');
    assert.equal(typeof cache.redisCache, 'function', 'ESM: cache subpath missing its export');
    const ioredisClient = await import('vern-llm-redis/clients/ioredis');
    assert.equal(typeof ioredisClient.fromIoredis, 'function', 'ESM: clients/ioredis subpath missing its export');
    const nodeRedisClient = await import('vern-llm-redis/clients/nodeRedis');
    assert.equal(
      typeof nodeRedisClient.fromNodeRedis,
      'function',
      'ESM: clients/nodeRedis subpath missing its export',
    );

    assert.ok(main.redisCache(fakeClient), 'ESM: redisCache failed to construct from the installed entry');
    assert.ok(
      main.redisCircuitBreaker(fakeClient),
      'ESM: redisCircuitBreaker failed to construct from the installed entry',
    );
    assert.ok(main.redisRateLimit(fakeClient), 'ESM: redisRateLimit failed to construct from the installed entry');
    console.log('ESM entry points ok');
  `;
  const esmFile = path.join(consumerDir, 'esm-check.mjs');
  writeFileSync(esmFile, esmScript);
  execFileSync('node', [esmFile], { cwd: consumerDir, stdio: 'inherit' });

  // CJS entry points, resolved through the same installed package's exports map.
  const cjsScript = `
    const assert = require('node:assert/strict');
    ${fakeClientSetup}

    const main = require('vern-llm-redis');
    assert.equal(typeof main.redisCache, 'function', 'CJS: redisCache missing from main entry');
    assert.equal(typeof main.redisCircuitBreaker, 'function', 'CJS: redisCircuitBreaker missing from main entry');
    assert.equal(typeof main.redisRateLimit, 'function', 'CJS: redisRateLimit missing from main entry');
    assert.equal(typeof main.fromIoredis, 'function', 'CJS: fromIoredis missing from main entry');
    assert.equal(typeof main.fromNodeRedis, 'function', 'CJS: fromNodeRedis missing from main entry');

    const cb = require('vern-llm-redis/circuitBreaker');
    assert.equal(typeof cb.redisCircuitBreaker, 'function', 'CJS: circuitBreaker subpath missing its export');
    const rl = require('vern-llm-redis/rateLimit');
    assert.equal(typeof rl.redisRateLimit, 'function', 'CJS: rateLimit subpath missing its export');
    const cache = require('vern-llm-redis/cache');
    assert.equal(typeof cache.redisCache, 'function', 'CJS: cache subpath missing its export');
    const ioredisClient = require('vern-llm-redis/clients/ioredis');
    assert.equal(typeof ioredisClient.fromIoredis, 'function', 'CJS: clients/ioredis subpath missing its export');
    const nodeRedisClient = require('vern-llm-redis/clients/nodeRedis');
    assert.equal(
      typeof nodeRedisClient.fromNodeRedis,
      'function',
      'CJS: clients/nodeRedis subpath missing its export',
    );

    assert.ok(main.redisCache(fakeClient), 'CJS: redisCache failed to construct from the installed entry');
    assert.ok(
      main.redisCircuitBreaker(fakeClient),
      'CJS: redisCircuitBreaker failed to construct from the installed entry',
    );
    assert.ok(main.redisRateLimit(fakeClient), 'CJS: redisRateLimit failed to construct from the installed entry');
    console.log('CJS entry points ok');
  `;
  const cjsFile = path.join(consumerDir, 'cjs-check.cjs');
  writeFileSync(cjsFile, cjsScript);
  execFileSync('node', [cjsFile], { cwd: consumerDir, stdio: 'inherit' });

  // Type declarations actually shipped in the installed package, for both
  // module systems, confirming `files`/`exports.types` include them.
  const installedTypesDir = path.join(consumerDir, 'node_modules', 'vern-llm-redis', 'dist');
  const shipped = readdirSync(installedTypesDir);
  assert.ok(shipped.includes('index.d.mts'), 'index.d.mts missing from installed package');
  assert.ok(shipped.includes('index.d.cts'), 'index.d.cts missing from installed package');

  console.log(
    'smoke test passed: installed ESM and CJS entry points (main and every subpath), types, and construction all work',
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
