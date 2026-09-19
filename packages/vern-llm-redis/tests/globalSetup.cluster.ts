import { Redis } from 'ioredis';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Starts a throwaway 3 node Redis Cluster for tests/integration/cluster.int.test.ts.
 *
 * It does not wait for the cluster to form. It picks ports, spawns the
 * nodes, publishes REDIS_CLUSTER_NODES and returns, so the other integration
 * files start straight away. Only the cluster file waits (see waitForCluster
 * in helpers.ts), which hides the ~2s formation time.
 *
 * REDIS_CLUSTER_NODES already set: used as is, nothing is started.
 * No redis-server binary: the cluster tests skip with a printed reason,
 * or, when CI is set, the run fails, so they can never quietly stop running.
 */

const NODE_COUNT = 3;
const SLOTS = 16384;

/** True when nothing is listening on the port. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Picks a random port pair where both the port and its cluster bus port
 * (port + 10000) are free. Drawn from a fixed range rather than the OS
 * ephemeral range, which differs per platform (macOS starts at 49152, so
 * port + 10000 would usually run past 65535).
 */
async function freeClusterPort(taken: Set<number>): Promise<number> {
  const MIN = 20_000;
  const MAX = 45_000;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = MIN + Math.floor(Math.random() * (MAX - MIN));
    if (taken.has(port) || taken.has(port + 10_000)) continue;
    if ((await isFree(port)) && (await isFree(port + 10_000))) return port;
  }
  throw new Error('could not find a free port pair for a cluster node');
}

function hasRedisServer(): boolean {
  return spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
}

async function waitForAllReady(ports: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await Promise.all(
      ports.map(async (port) => {
        const node = new Redis({
          host: '127.0.0.1',
          port,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        });
        try {
          await node.connect();
          const info = await node.cluster('INFO');
          return (
            String(info).includes('cluster_state:ok') &&
            String(info).includes(`cluster_known_nodes:${ports.length}`)
          );
        } catch {
          return false;
        } finally {
          node.disconnect();
        }
      }),
    );
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the test cluster was not ready within ${timeoutMs}ms`);
}

/** Resolves once every node answers PING, so the join below runs exactly once. */
async function waitForNodesUp(ports: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const port of ports) {
    for (;;) {
      const node = new Redis({
        host: '127.0.0.1',
        port,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
      });
      try {
        await node.connect();
        await node.ping();
        break;
      } catch {
        if (Date.now() > deadline)
          throw new Error(`node ${port} did not start within ${timeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        node.disconnect();
      }
    }
  }
}

/** Splits the slots over the nodes and joins them, using plain commands so redis-cli is not needed. */
async function formCluster(ports: number[]): Promise<void> {
  const nodes = ports.map(
    (port) => new Redis({ host: '127.0.0.1', port, maxRetriesPerRequest: 20 }),
  );
  try {
    const per = Math.floor(SLOTS / ports.length);
    await Promise.all(
      nodes.map(async (node, i) => {
        const start = i * per;
        const end = i === ports.length - 1 ? SLOTS - 1 : start + per - 1;
        await node.cluster('ADDSLOTSRANGE', start, end);
        await node.cluster('SET-CONFIG-EPOCH', i + 1);
      }),
    );
    await Promise.all(nodes.slice(1).map((node) => node.cluster('MEET', '127.0.0.1', ports[0]!)));
  } finally {
    for (const node of nodes) node.disconnect();
  }
}

export default async function setup(): Promise<(() => void) | void> {
  if (process.env.REDIS_CLUSTER_NODES) return;

  try {
    return await start();
  } catch (error) {
    const reason = (error as Error).message;
    // In CI a broken cluster must fail the run. Locally it must not take the
    // other integration files down with it, so the cluster tests just skip.
    if (process.env.CI) throw error;
    delete process.env.REDIS_CLUSTER_NODES;
    console.warn(`[cluster] skipping cluster tests: ${reason}`);
  }
}

async function start(): Promise<(() => void) | void> {
  if (!hasRedisServer()) {
    const reason =
      'redis-server was not found on PATH, so the cluster tests cannot start a cluster.';
    if (process.env.CI) throw new Error(`${reason} Install it, or set REDIS_CLUSTER_NODES.`);
    process.env.REDIS_CLUSTER_SKIP_REASON = reason;
    console.warn(`[cluster] skipping cluster tests: ${reason}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'vern-redis-cluster-'));
  const children: ChildProcess[] = [];
  const taken = new Set<number>();
  const ports: number[] = [];

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const child of children) child.kill('SIGKILL');
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort, the OS clears the temp directory eventually.
    }
  };
  // 'exit' covers a normal end and a crash, the signals cover Ctrl-C and a kill.
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  try {
    for (let i = 0; i < NODE_COUNT; i++) {
      const port = await freeClusterPort(taken);
      taken.add(port);
      taken.add(port + 10_000);
      ports.push(port);

      const nodeDir = join(dir, String(port));
      spawnSync('mkdir', ['-p', nodeDir]);
      const child = spawn(
        'redis-server',
        [
          '--port',
          String(port),
          '--bind',
          '127.0.0.1',
          '--dir',
          nodeDir,
          '--cluster-enabled',
          'yes',
          '--cluster-config-file',
          'nodes.conf',
          '--cluster-node-timeout',
          '5000',
          '--save',
          '',
          '--appendonly',
          'no',
        ],
        { stdio: 'ignore' },
      );
      child.on('error', (error) =>
        console.warn(`[cluster] node ${port} failed to start: ${error.message}`),
      );
      children.push(child);
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  // Published before formation finishes: workers inherit it when they start.
  process.env.REDIS_CLUSTER_NODES = ports.map((port) => `127.0.0.1:${port}`).join(',');

  // Formation runs in the background. The cluster test file waits for it.
  const formed = (async () => {
    await waitForNodesUp(ports, 10_000);
    await formCluster(ports);
    await waitForAllReady(ports, 15_000);
  })();
  formed.catch((error) => console.warn(`[cluster] formation failed: ${(error as Error).message}`));

  return cleanup;
}
