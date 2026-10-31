import { describe, expect, it, vi } from 'vitest';

import {
  bedrockGuardrail,
  type BedrockGuardrailOptions,
  type Segment,
} from '../../src/guardrail/index.js';
import { at, stubbedClient, type ApplyGuardrailHandler } from '../helpers.js';

import type { Logger } from 'vern-llm';

const user = (text: string): Segment => ({ text, source: 'user' });
const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const EMAIL = 'jane@acme.com';
const email = {
  sensitiveInformationPolicy: {
    piiEntities: [{ type: 'EMAIL', match: EMAIL, action: 'ANONYMIZED', detected: true }],
    regexes: [],
  },
};
const topic = {
  topicPolicy: { topics: [{ name: 'Investing', type: 'DENY', action: 'BLOCKED', detected: true }] },
};

/** What a guardrail answers for a text: an email assessment when it has one, a topic when it says "stocks". */
const answer = (text: string) => ({
  assessments: [
    ...(text.includes(EMAIL) ? [email] : []),
    ...(text.includes('stocks') ? [topic] : []),
  ],
  usage: { topicPolicyUnits: 1 },
});

const textOf = (input: Parameters<ApplyGuardrailHandler>[0]): string =>
  at(input.content ?? [], 0).text!.text!;

/** A detector over a stubbed client, and every request the client was sent. */
function setup(
  options: Partial<BedrockGuardrailOptions> = {},
  handler: ApplyGuardrailHandler = async (input) => answer(textOf(input)),
) {
  const requests: Parameters<ApplyGuardrailHandler>[0][] = [];
  const signals: AbortSignal[] = [];
  const client = stubbedClient({
    applyGuardrail: async (input, { signal }) => {
      requests.push(input);
      signals.push(signal);
      return handler(input, { signal });
    },
  });
  const detect = bedrockGuardrail({
    client,
    guardrailIdentifier: 'gr-abc',
    guardrailVersion: '3',
    logger: 'silent',
    ...options,
  });
  return { detect, requests, signals, signal: new AbortController().signal };
}

describe('bedrockGuardrail', () => {
  describe('the request', () => {
    it('sends one request per segment, naming the guardrail and the text', async () => {
      const { detect, requests, signal } = setup();

      await detect([user('one'), user('two')], signal);

      expect(requests).toEqual([
        {
          guardrailIdentifier: 'gr-abc',
          guardrailVersion: '3',
          source: 'INPUT',
          content: [{ text: { text: 'one' } }],
        },
        {
          guardrailIdentifier: 'gr-abc',
          guardrailVersion: '3',
          source: 'INPUT',
          content: [{ text: { text: 'two' } }],
        },
      ]);
    });

    it('reads the model’s answer as OUTPUT and every other source as INPUT', async () => {
      const { detect, requests, signal } = setup();

      await detect(
        [
          { text: 'a', source: 'user' },
          { text: 'b', source: 'tool' },
          { text: 'c', source: 'system' },
          { text: 'd', source: 'assistant' },
          { text: 'e', source: 'output' },
        ],
        signal,
      );

      expect(requests.map((request) => request.source)).toEqual([
        'INPUT',
        'INPUT',
        'INPUT',
        'INPUT',
        'OUTPUT',
      ]);
    });

    it('passes the abort signal to the client, and sends nothing for an empty text', async () => {
      const { detect, requests, signals, signal } = setup();

      expect(await detect([user('  \n'), user('')], signal)).toEqual([]);
      expect(requests).toHaveLength(0);

      await detect([user('hi')], signal);
      expect(signals).toHaveLength(1);
    });
  });

  describe('findings and views', () => {
    it('numbers findings by segment, with spans for matches and none for topics', async () => {
      const { detect, signal } = setup();

      expect(await detect([user(`mail ${EMAIL}`), user('plain'), user('stocks')], signal)).toEqual([
        { segment: 0, label: 'pii.EMAIL', start: 5, end: 5 + EMAIL.length },
        { segment: 2, label: 'topic.Investing' },
      ]);
    });

    it('narrows to some kinds with only()', async () => {
      const { detect, signal } = setup();
      const both = [user(`${EMAIL} and stocks`)];

      expect(await detect.only('topic')(both, signal)).toEqual([
        { segment: 0, label: 'topic.Investing' },
      ]);
      expect(await detect.only('pii', 'regex')(both, signal)).toHaveLength(1);
    });

    it('refuses a view of no kinds, or of an unknown one', () => {
      const { detect } = setup();

      expect(() => detect.only()).toThrow('bedrockGuardrail: only() needs at least one kind');
      expect(() => detect.only('nope' as never)).toThrow('bedrockGuardrail: unknown kind "nope"');
    });
  });

  describe('one request per text', () => {
    it('asks once for a text however many views read it, and not again on the next call', async () => {
      const { detect, requests, signal } = setup();
      const same = [user(`${EMAIL} stocks`)];

      await detect.only('pii')(same, signal);
      await detect.only('topic')(same, signal);
      await detect(same, signal);

      expect(requests).toHaveLength(1);
    });

    it('lets views that ask at the same moment share one request', async () => {
      const { detect, requests, signal } = setup({}, async (input) => {
        await later(10);
        return answer(textOf(input));
      });

      await Promise.all([
        detect.only('pii')([user(EMAIL)], signal),
        detect.only('topic')([user(EMAIL)], signal),
      ]);

      expect(requests).toHaveLength(1);
    });

    it('keeps a text from one source apart from the same text from another', async () => {
      const { detect, requests, signal } = setup();

      await detect([user('x'), { text: 'x', source: 'output' }], signal);

      expect(requests.map((request) => request.source)).toEqual(['INPUT', 'OUTPUT']);
    });

    it('remembers a text with nothing found as well as one with findings', async () => {
      const { detect, requests, signal } = setup();

      await detect([user('clean')], signal);
      expect(await detect([user('clean')], signal)).toEqual([]);

      expect(requests).toHaveLength(1);
    });

    it('asks again for every call when the cache is off', async () => {
      const { detect, requests, signal } = setup({ cache: false });

      await detect([user('x')], signal);
      await detect([user('x')], signal);

      expect(requests).toHaveLength(2);
    });

    it('forgets the oldest text once the cache holds its maximum', async () => {
      const { detect, requests, signal } = setup({ cache: { max: 1 } });

      await detect([user('a')], signal);
      await detect([user('b')], signal);
      await detect([user('a')], signal);

      expect(requests).toHaveLength(3);
    });
  });

  describe('a DRAFT guardrail', () => {
    const capture = () => {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => {},
        error: () => {},
        warn: (m) => void warnings.push(m),
      };
      return { logger, warnings };
    };

    it('warns once, and is never cached, since it can change', async () => {
      const { logger, warnings } = capture();
      const { detect, requests, signal } = setup({ guardrailVersion: 'DRAFT', logger });

      await detect([user('x')], signal);
      await detect([user('x')], signal);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('DRAFT');
      expect(requests).toHaveLength(2);
    });

    it('stays silent for a published version, and when the logger is silent', () => {
      const { logger, warnings } = capture();

      setup({ guardrailVersion: '3', logger });
      setup({ guardrailVersion: 'DRAFT', logger: 'silent' });

      expect(warnings).toEqual([]);
    });

    it('does not fail construction when the logger throws', () => {
      const logger: Logger = {
        debug: () => {},
        error: () => {},
        warn: () => {
          throw new Error('logger broke');
        },
      };

      expect(() => setup({ guardrailVersion: 'DRAFT', logger })).not.toThrow();
    });

    it('warns through a console logger when none is given', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      setup({ guardrailVersion: 'DRAFT', logger: undefined });

      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });
  });

  describe('long texts', () => {
    const filler = (size: number): string =>
      'calm words '.repeat(Math.ceil(size / 11)).slice(0, size);

    it('checks a long text in chunks and puts spans back on the whole text', async () => {
      const { detect, requests, signal } = setup({ chunkChars: 1000, overlapChars: 0 });
      const text = `${filler(1500)}${EMAIL}${filler(10)}`;

      const found = await detect([user(text)], signal);

      expect(requests.length).toBeGreaterThan(1);
      expect(found).toEqual([
        { segment: 0, label: 'pii.EMAIL', start: 1500, end: 1500 + EMAIL.length },
      ]);
    });

    it('finds a value on a chunk boundary once, from the chunk that holds it whole', async () => {
      const { detect, signal } = setup({ chunkChars: 1000, overlapChars: 200 });
      const text = `${filler(995)}${EMAIL}${filler(1200)}`;

      const found = await detect([user(text)], signal);

      expect(found).toEqual([
        { segment: 0, label: 'pii.EMAIL', start: 995, end: 995 + EMAIL.length },
      ]);
    });
  });

  describe('the limit on requests', () => {
    it('never has more than `concurrency` requests in flight', async () => {
      let active = 0;
      let peak = 0;
      const { detect, requests, signal } = setup({ concurrency: 2 }, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await later(10);
        active -= 1;
        return { assessments: [] };
      });

      await detect(['a', 'b', 'c', 'd', 'e', 'f'].map(user), signal);

      expect(requests).toHaveLength(6);
      expect(peak).toBe(2);
    });
  });

  describe('failures', () => {
    it('throws what the client throws, as it is, and remembers nothing of it', async () => {
      const down = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      let fail = true;
      const { detect, requests, signal } = setup({}, async () => {
        if (fail) throw down;
        return { assessments: [] };
      });

      await expect(detect([user('x')], signal)).rejects.toBe(down);

      fail = false;
      expect(await detect([user('x')], signal)).toEqual([]);
      expect(requests).toHaveLength(2);
    });

    it.each([
      ['no assessments', {}],
      ['assessments that are not a list', { assessments: 'none' }],
      ['an empty response', undefined],
    ])('refuses a response with %s rather than let the text through', async (_name, response) => {
      const { detect, signal } = setup({}, async () => response);

      await expect(detect([user('x')], signal)).rejects.toThrow(
        'bedrockGuardrail: the API answered without assessments',
      );
    });

    it('stops the requests still queued when one fails', async () => {
      const { detect, requests, signal } = setup({ concurrency: 1 }, async (input) => {
        if (textOf(input) === 'a') throw new Error('first fails');
        return { assessments: [] };
      });

      await expect(detect(['a', 'b', 'c'].map(user), signal)).rejects.toThrow('first fails');
      await later(10);

      expect(requests.map(textOf)).toEqual(['a']);
    });

    it('stops waiting, and cancels the request, when the call is aborted', async () => {
      const { detect, signals } = setup({}, (_input, { signal }) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      const controller = new AbortController();
      const pending = detect([user('slow')], controller.signal);
      await later(5);

      controller.abort(new Error('timed out'));

      await expect(pending).rejects.toThrow('timed out');
      expect(signals[0]!.aborted).toBe(true);
    });

    it('asks for nothing when the call has already stopped', async () => {
      const { detect, requests } = setup();
      const stopped = AbortSignal.abort(new Error('gone'));

      await expect(detect([user('x')], stopped)).rejects.toThrow('gone');
      expect(requests).toHaveLength(0);
    });
  });

  describe('onUsage', () => {
    it('reports each request with the guardrail, the units and the time', async () => {
      const onUsage = vi.fn();
      const { detect, signal } = setup({ onUsage });

      await detect([user('x')], signal);

      expect(onUsage).toHaveBeenCalledExactlyOnceWith({
        guardrailIdentifier: 'gr-abc',
        guardrailVersion: '3',
        usage: { topicPolicyUnits: 1 },
        ms: expect.any(Number),
      });
    });

    it('is not failed by a callback that throws', async () => {
      const { detect, signal } = setup({
        onUsage: () => {
          throw new Error('metrics down');
        },
      });

      await expect(detect([user('x')], signal)).resolves.toEqual([]);
    });
  });

  describe('options', () => {
    const base = {
      client: { send: async () => ({}) },
      guardrailIdentifier: 'g',
      guardrailVersion: '1',
    };

    it.each([
      [{ client: {} }, 'bedrockGuardrail: client.send must be a function'],
      [
        { guardrailIdentifier: '' },
        'bedrockGuardrail: guardrailIdentifier must be a non empty string',
      ],
      [{ guardrailVersion: 3 }, 'bedrockGuardrail: guardrailVersion must be a non empty string'],
      [{ concurrency: 0 }, 'bedrockGuardrail: concurrency must be an integer of at least 1'],
      [{ chunkChars: 999 }, 'bedrockGuardrail: chunkChars must be an integer of at least 1000'],
      [
        { overlapChars: 12_000 },
        'bedrockGuardrail: overlapChars must be an integer of at least 0 and below chunkChars',
      ],
      [{ overlapChars: -1 }, 'bedrockGuardrail: overlapChars must be an integer of at least 0'],
      [{ cache: null }, 'bedrockGuardrail: cache must be false or an object with max'],
      [{ cache: { max: 0 } }, 'bedrockGuardrail: cache.max must be an integer of at least 1'],
      [{ onUsage: 'no' }, 'bedrockGuardrail: onUsage must be a function'],
    ])('refuses %j', (bad, message) => {
      expect(() => bedrockGuardrail({ ...base, ...bad } as never)).toThrow(message);
    });

    it('accepts the defaults, a smaller chunk size, and a cache with only max', () => {
      expect(() => bedrockGuardrail(base as never)).not.toThrow();
      expect(() =>
        bedrockGuardrail({
          ...base,
          chunkChars: 1000,
          overlapChars: 0,
          cache: { max: 5 },
        } as never),
      ).not.toThrow();
    });
  });
});
