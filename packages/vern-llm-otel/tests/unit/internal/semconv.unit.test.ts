import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_COUNT_BUCKETS,
  ATTR,
  CALL_OUTCOME,
  DURATION_BUCKETS,
  EVENT_ATTR,
  METRIC,
  NO_ATTEMPT_REASON,
  SEMCONV_STATUS,
  SEMCONV_VERSION,
  SPAN,
  SPAN_EVENT,
  TOKEN_USAGE_BUCKETS,
  VERNLLM_ATTR,
} from '../../../src/internal/semconv.js';

const values = (record: Record<string, string>): string[] => Object.values(record);

describe('names', () => {
  it.each([
    ['ATTR', ATTR],
    ['VERNLLM_ATTR', VERNLLM_ATTR],
    ['METRIC', METRIC],
    ['SPAN', SPAN],
    ['SPAN_EVENT', SPAN_EVENT],
    ['NO_ATTEMPT_REASON', NO_ATTEMPT_REASON],
    ['CALL_OUTCOME', CALL_OUTCOME],
  ])('%s has no duplicate values and no empty ones', (_name, record) => {
    const all = values(record);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((value) => value.trim() !== '')).toBe(true);
  });

  it('keeps VernLLM specific telemetry out of the gen_ai namespace the spec owns', () => {
    for (const name of [...values(VERNLLM_ATTR), ...values(SPAN), ...values(SPAN_EVENT)]) {
      expect(name.startsWith('gen_ai.')).toBe(false);
    }
    for (const name of values(VERNLLM_ATTR)) expect(name.startsWith('vernllm.')).toBe(true);
  });

  it('puts every metric under either the GenAI client namespace or vernllm', () => {
    for (const name of values(METRIC)) {
      expect(name.startsWith('gen_ai.client.') || name.startsWith('vernllm.')).toBe(true);
    }
  });

  it('uses plain keys for span event attributes, which are scoped by their event', () => {
    for (const key of values(EVENT_ATTR)) expect(key.includes('.')).toBe(false);
  });
});

describe('buckets', () => {
  it.each([
    ['token usage', TOKEN_USAGE_BUCKETS],
    ['duration', DURATION_BUCKETS],
    ['attempt count', ATTEMPT_COUNT_BUCKETS],
  ])('%s boundaries are positive and strictly ascending', (_name, buckets) => {
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((bound) => Number.isFinite(bound) && bound > 0)).toBe(true);
    for (let index = 1; index < buckets.length; index++) {
      expect(buckets[index]!).toBeGreaterThan(buckets[index - 1]!);
    }
  });

  it('matches the boundaries the GenAI conventions advise', () => {
    expect(TOKEN_USAGE_BUCKETS).toEqual([
      1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
    ]);
    expect(DURATION_BUCKETS).toEqual([
      0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
    ]);
  });
});

describe('version', () => {
  it('records the release the names were written against and their status', () => {
    expect(SEMCONV_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SEMCONV_STATUS).toBe('development');
  });
});
