import { describe, expect, it, vi } from 'vitest';

import { ErrorGrouper } from '../../../../src/internal/detectors/errorGrouper.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { createFinalize } from '../../../../src/internal/pipeline/finalize.js';
import { SeriesRegistry } from '../../../../src/internal/stats/seriesRegistry.js';

import type { CallLogRecord, LogLevel, LogSink } from '../../../../src/index.js';

const record = (level: LogLevel): CallLogRecord => ({
  kind: 'call',
  v: 1,
  ts: '2026-01-01T00:00:00.000Z',
  requestId: 'req',
  outcome: 'ok',
  level,
  attempts: 1,
  retries: 0,
  streaming: false,
  durationMs: 1,
  queueWaitMs: 0,
  retryDelayMs: 0,
  path: [],
});

const recordingLogger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
const build = (
  sink: LogSink,
  level: LogLevel = 'info',
  logger: ReturnType<typeof recordingLogger> | 'silent' = 'silent',
) => {
  const config = normalizeOptions({ sink, level, logger });
  const guard = createGuard(logger);
  return createFinalize(
    config,
    guard,
    new SeriesRegistry(config, guard),
    new ErrorGrouper(config.window.durationMs),
  );
};

describe('createFinalize', () => {
  it('writes a record at its own level', () => {
    const write = vi.fn();
    const rec = record('warn');
    build({ write })(rec);

    expect(write).toHaveBeenCalledWith('warn', rec);
  });

  it.each([
    ['debug', 'info', false],
    ['info', 'info', true],
    ['warn', 'info', true],
    ['info', 'warn', false],
    ['warn', 'warn', true],
    ['error', 'warn', true],
    ['warn', 'error', false],
    ['error', 'error', true],
    ['debug', 'debug', true],
  ] as const)('a %s record with the minimum at %s is written: %s', (level, minimum, written) => {
    const write = vi.fn();
    build({ write }, minimum)(record(level));

    expect(write).toHaveBeenCalledTimes(written ? 1 : 0);
  });

  it('survives a sink that throws, and reports it', () => {
    const logger = recordingLogger();
    const finalize = build(
      {
        write: () => {
          throw new Error('disk full');
        },
      },
      'info',
      logger,
    );

    expect(() => finalize(record('info'))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] logger: sink.write failed',
      expect.objectContaining({ message: 'disk full' }),
    );
  });

  it('never waits for an async sink', () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalize = build({ write: () => pending });

    expect(finalize(record('info'))).toBeUndefined();
    release();
  });

  it('reports a rejecting sink once, however many writes reject', async () => {
    const logger = recordingLogger();
    const finalize = build({ write: () => Promise.reject(new Error('network')) }, 'info', logger);

    finalize(record('info'));
    finalize(record('info'));
    finalize(record('info'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] logger: sink.write failed',
      expect.objectContaining({ message: 'network' }),
    );
  });

  it('does not report a sink promise that resolves', async () => {
    const logger = recordingLogger();
    build({ write: () => Promise.resolve() }, 'info', logger)(record('info'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('createFinalize edges', () => {
  it('writes an entry given without a level at info', () => {
    const write = vi.fn();
    const entry = {
      kind: 'breaker',
      v: 1,
      provider: 'p',
      model: 'm',
      from: 'closed',
      to: 'open',
      consecutiveFailures: 1,
    } as const;
    build({ write })(entry);

    expect(write).toHaveBeenCalledWith('info', entry);
  });

  it('never lowers a slow call that is already above warn', () => {
    const write = vi.fn();
    const config = normalizeOptions({
      sink: { write },
      logger: 'silent',
      slowCall: { thresholdMs: 5 },
    });
    const guard = createGuard('silent');
    const finalize = createFinalize(
      config,
      guard,
      new SeriesRegistry(config, guard),
      new ErrorGrouper(config.window.durationMs),
    );

    finalize({ ...record('error'), durationMs: 50, attempts: 1 });

    expect(write).toHaveBeenCalledWith('error', expect.objectContaining({ reason: 'slow' }));
  });
});
