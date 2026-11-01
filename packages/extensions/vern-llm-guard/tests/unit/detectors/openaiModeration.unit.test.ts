import { describe, expect, it, vi } from 'vitest';

import {
  openaiModeration,
  type Finding,
  type ImageSegment,
  type ModerationClient,
  type Segment,
} from '../../../src/index.js';
import { captureLogger, createModerationClient, type Scores } from '../../helpers.js';

const signal = new AbortController().signal;
const user = (text: string): Segment => ({ text, source: 'user' });
const tool = (text: string): Segment => ({ text, source: 'tool' });

/** A scorer that flags a text by a word it contains: `violence`, `hate`, `self-harm/intent`. */
const byWord = (text: string): Scores => {
  const scores: Scores = {};
  if (text.includes('violence')) scores.violence = 0.9;
  if (text.includes('hate')) scores.hate = 0.8;
  if (text.includes('maybe')) scores.violence = 0.4;
  if (text.includes('harm')) scores['self-harm/intent'] = 0.95;
  return scores;
};

function setup(scorer = byWord, options: Partial<Parameters<typeof openaiModeration>[0]> = {}) {
  const stub = createModerationClient(scorer);
  const detect = openaiModeration({
    client: stub.client,
    model: 'omni-moderation-2024-09-26',
    ...options,
  });
  return { detect, ...stub };
}

const run = async (
  detect: ReturnType<typeof openaiModeration>,
  ...segments: Segment[]
): Promise<Finding[]> => detect(segments, signal);

describe('openaiModeration', () => {
  describe('findings', () => {
    it('labels each flagged category over the whole segment, with no span', async () => {
      const { detect } = setup();

      expect(await run(detect, user('fine'), user('violence and hate'))).toEqual([
        { segment: 1, label: 'moderation.hate' },
        { segment: 1, label: 'moderation.violence' },
      ]);
    });

    it('labels a category with a slash in its name', async () => {
      const { detect } = setup();

      expect(await run(detect, user('self harm'))).toEqual([
        { segment: 0, label: 'moderation.self-harm/intent' },
      ]);
    });

    it('returns only the categories of a view', async () => {
      const { detect } = setup();

      expect(await detect.only('violence')([user('violence and hate')], signal)).toEqual([
        { segment: 0, label: 'moderation.violence' },
      ]);
      expect(
        await detect.only('hate', 'violence')([user('violence and hate')], signal),
      ).toHaveLength(2);
    });

    it('finds nothing in a text that is fine', async () => {
      const { detect } = setup();

      expect(await run(detect, user('a recipe for soup'))).toEqual([]);
    });

    it('returns a category the API reports that it does not know, to the whole detector only', async () => {
      const client: ModerationClient = {
        moderations: {
          create: async (body) => ({
            results: body.input.map(() => ({
              categories: { 'future/thing': true, hate: false } as never,
            })),
          }),
        },
      };
      const detect = openaiModeration({ client, model: 'pinned' });

      expect(await run(detect, user('x'))).toEqual([
        { segment: 0, label: 'moderation.future/thing' },
      ]);
      expect(await detect.only('hate')([user('x')], signal)).toEqual([]);
    });
  });

  describe('thresholds', () => {
    it('counts a category at or above its threshold, even when the API did not flag it', async () => {
      const { detect } = setup(byWord, { thresholds: { violence: 0.3 } });

      expect(await run(detect, user('maybe'))).toEqual([
        { segment: 0, label: 'moderation.violence' },
      ]);
    });

    it('does not count a category below its threshold, even when the API flagged it', async () => {
      const { detect } = setup(byWord, { thresholds: { violence: 0.95 } });

      expect(await run(detect, user('violence'))).toEqual([]);
    });

    it('counts a score exactly at the threshold, and leaves other categories to their flag', async () => {
      const { detect } = setup(byWord, { thresholds: { hate: 0.8 } });

      expect(await run(detect, user('hate violence'))).toEqual([
        { segment: 0, label: 'moderation.hate' },
        { segment: 0, label: 'moderation.violence' },
      ]);
    });

    it('does not count a category with a threshold when its score is missing', async () => {
      const client: ModerationClient = {
        moderations: {
          create: async (body) => ({
            results: body.input.map(() => ({ categories: { hate: true }, category_scores: {} })),
          }),
        },
      };
      const detect = openaiModeration({ client, model: 'pinned', thresholds: { hate: 0.5 } });

      expect(await run(detect, user('x'))).toEqual([]);
    });
  });

  describe('requests', () => {
    it('sends the texts of a call in one request, as a list, with the model', async () => {
      const { detect, calls } = setup();

      await run(detect, user('one'), user('two'), tool('three'));

      expect(calls).toEqual([
        {
          model: 'omni-moderation-2024-09-26',
          input: ['one', 'two', 'three'],
          signal: expect.any(AbortSignal),
        },
      ]);
    });

    it('splits a long list into requests of batchSize, and puts the answers back in order', async () => {
      const { detect, calls } = setup(byWord, { batchSize: 2 });

      const found = await run(
        detect,
        user('one'),
        user('violence'),
        user('three'),
        user('hate'),
        user('five'),
      );

      expect(calls.map((call) => call.input)).toEqual([
        ['one', 'violence'],
        ['three', 'hate'],
        ['five'],
      ]);
      expect(found).toEqual([
        { segment: 1, label: 'moderation.violence' },
        { segment: 3, label: 'moderation.hate' },
      ]);
    });

    it('limits the requests in flight', async () => {
      const stub = createModerationClient(byWord, { delayMs: 5 });
      const detect = openaiModeration({
        client: stub.client,
        model: 'pinned',
        batchSize: 1,
        concurrency: 2,
      });

      await run(detect, user('a'), user('b'), user('c'), user('d'), user('e'));

      expect(stub.calls).toHaveLength(5);
      expect(stub.peak()).toBe(2);
    });

    it('leaves out text with nothing in it, and finds nothing there', async () => {
      const { detect, calls } = setup();

      expect(await run(detect, user(''), user('  \n'), user('violence'))).toEqual([
        { segment: 2, label: 'moderation.violence' },
      ]);
      expect(calls.map((call) => call.input)).toEqual([['violence']]);

      expect(await run(detect, user(''))).toEqual([]);
      expect(calls).toHaveLength(1);
    });

    it('asks once for a text, however many times it comes or views read it', async () => {
      const { detect, calls } = setup();

      await run(detect, user('violence'), user('violence'));
      await detect.only('violence')([user('violence')], signal);
      await detect.only('hate')([user('violence')], signal);

      expect(calls.map((call) => call.input)).toEqual([['violence']]);
    });

    it('asks again for the same text from another source', async () => {
      const { detect, calls } = setup();

      await run(detect, user('violence'));
      await run(detect, tool('violence'));

      expect(calls).toHaveLength(2);
    });

    it('asks again each time with cache off', async () => {
      const { detect, calls } = setup(byWord, { cache: false });

      await run(detect, user('violence'));
      await run(detect, user('violence'));

      expect(calls).toHaveLength(2);
    });

    it('passes the abort signal on, and does not send once it has aborted', async () => {
      const { detect, calls } = setup();
      const controller = new AbortController();

      await detect([user('violence')], controller.signal);
      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);

      controller.abort(new Error('timed out'));
      await expect(detect([user('another')], controller.signal)).rejects.toThrow('timed out');
      expect(calls).toHaveLength(1);
    });

    it('does not send a request that was still queued when the signal aborted', async () => {
      const stub = createModerationClient(byWord, { delayMs: 30 });
      const detect = openaiModeration({
        client: stub.client,
        model: 'pinned',
        batchSize: 1,
        concurrency: 1,
      });
      const controller = new AbortController();

      const pending = detect([user('a'), user('b')], controller.signal);
      setTimeout(() => controller.abort(new Error('timed out')), 5);

      await expect(pending).rejects.toThrow('timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stub.calls).toHaveLength(1);
    });

    it('stops waiting when the signal aborts mid request', async () => {
      const stub = createModerationClient(byWord, { delayMs: 50 });
      const detect = openaiModeration({ client: stub.client, model: 'pinned' });
      const controller = new AbortController();

      const pending = detect([user('violence')], controller.signal);
      setTimeout(() => controller.abort(new Error('timed out')), 5);

      await expect(pending).rejects.toThrow('timed out');
    });
  });

  describe('long texts', () => {
    const filler = (length: number): string =>
      'word '.repeat(Math.ceil(length / 5)).slice(0, length);

    it('checks a long text in chunks, as one segment', async () => {
      const { detect, calls } = setup(byWord, { chunkChars: 1000, overlapChars: 0 });
      const text = `${filler(1000)}${filler(1000)}violence ${filler(500)}`;

      const found = await run(detect, user('short'), user(text));

      expect(calls[0]!.input).toHaveLength(1 + 3);
      expect(found).toEqual([{ segment: 1, label: 'moderation.violence' }]);
    });

    it('reports a category once when several chunks of a text have it', async () => {
      const { detect } = setup(byWord, { chunkChars: 1000, overlapChars: 0 });
      const text = `violence ${filler(1500)} violence`;

      expect(await run(detect, user(text))).toEqual([{ segment: 0, label: 'moderation.violence' }]);
    });

    it('lets a chunk start inside the end of the one before', async () => {
      const { detect, calls } = setup(byWord, { chunkChars: 1000, overlapChars: 100 });

      await run(detect, user(filler(1500)));

      const [first, second] = calls[0]!.input;
      expect(first).toHaveLength(1000);
      expect(second!.slice(0, 100)).toBe(first!.slice(900));
    });
  });

  describe('when the API misbehaves', () => {
    const answering = (results: unknown): ModerationClient =>
      ({ moderations: { create: async () => ({ results }) } }) as ModerationClient;

    it('throws what the client threw', async () => {
      const failure = Object.assign(new Error('rate limited'), { status: 429 });
      const stub = createModerationClient(byWord, { error: failure });
      const detect = openaiModeration({ client: stub.client, model: 'pinned' });

      await expect(run(detect, user('x'))).rejects.toBe(failure);
    });

    it('throws rather than guess when the results do not match the texts', async () => {
      const detect = openaiModeration({ client: answering([]), model: 'pinned' });

      await expect(run(detect, user('x'))).rejects.toThrow(
        'openaiModeration: the API answered for the wrong number of texts',
      );
    });

    it('throws when there is no list of results', async () => {
      const detect = openaiModeration({ client: answering(undefined), model: 'pinned' });

      await expect(run(detect, user('x'))).rejects.toThrow(/wrong number of texts/);
    });

    it.each([[null], [{}], [{ categories: null }], [{ categories: 'violence' }]])(
      'throws on a result without categories: %j',
      async (bad) => {
        const detect = openaiModeration({ client: answering([bad]), model: 'pinned' });

        await expect(run(detect, user('x'))).rejects.toThrow(
          'openaiModeration: the API returned a result without categories',
        );
      },
    );

    it('throws on a result without scores when a threshold needs them', async () => {
      const detect = openaiModeration({
        client: answering([{ categories: { hate: true } }]),
        model: 'pinned',
        thresholds: { hate: 0.5 },
      });
      await expect(run(detect, user('x'))).rejects.toThrow(
        'openaiModeration: the API returned a result without scores',
      );

      const nullScores = openaiModeration({
        client: answering([{ categories: { hate: true }, category_scores: null }]),
        model: 'pinned',
        thresholds: { hate: 0.5 },
      });
      await expect(run(nullScores, user('x'))).rejects.toThrow(/without scores/);
    });

    it('does not need scores without thresholds', async () => {
      const detect = openaiModeration({
        client: answering([{ categories: { hate: true } }]),
        model: 'pinned',
      });

      expect(await run(detect, user('x'))).toEqual([{ segment: 0, label: 'moderation.hate' }]);
    });
  });

  describe('the model alias', () => {
    it('warns once that the default alias can change under the memo', async () => {
      const log = captureLogger();
      const { client } = createModerationClient();
      const detect = openaiModeration({ client, logger: log.logger });

      await detect([user('a')], signal);
      await detect([user('b')], signal);

      expect(log.warnings()).toHaveLength(1);
      expect(log.warnings()[0]).toContain('"omni-moderation-latest" is an alias');
      expect(log.warnings()[0]).toContain('set model to a dated snapshot');
    });

    it('does not warn for a pinned model', () => {
      const log = captureLogger();
      const { client } = createModerationClient();

      openaiModeration({ client, model: 'omni-moderation-2024-09-26', logger: log.logger });

      expect(log.warnings()).toEqual([]);
    });

    it('uses the model it was given in the request', async () => {
      const { detect, calls } = setup(byWord, { model: 'omni-moderation-2025-01-01' });

      await run(detect, user('x'));

      expect(calls[0]!.model).toBe('omni-moderation-2025-01-01');
    });

    it('can be silenced', () => {
      const { client } = createModerationClient();

      expect(() => openaiModeration({ client, logger: 'silent' })).not.toThrow();
    });
  });

  describe('onUsage', () => {
    it('reports each request with its model, size and time', async () => {
      const onUsage = vi.fn();
      const { detect } = setup(byWord, { onUsage, batchSize: 2 });

      await run(detect, user('a'), user('b'), user('c'));

      expect(onUsage).toHaveBeenCalledTimes(2);
      expect(onUsage.mock.calls.map(([info]) => info.texts)).toEqual([2, 1]);
      expect(onUsage.mock.calls[0]![0]).toEqual({
        model: 'omni-moderation-2024-09-26',
        texts: 2,
        ms: expect.any(Number),
      });
    });

    it('does not let a throwing callback fail the check', async () => {
      const { detect } = setup(byWord, {
        onUsage: () => {
          throw new Error('metrics down');
        },
      });

      expect(await run(detect, user('violence'))).toHaveLength(1);
    });
  });
});

describe('openaiModeration with images', () => {
  const picture = (data: string, mimeType = 'image/png'): ImageSegment => ({
    image: { data, mimeType },
    source: 'user',
  });
  /** What the guard calls it with: images go only to a detector that says it takes them. */
  const readAll = (
    detect: ReturnType<typeof openaiModeration>,
    ...segments: (Segment | ImageSegment)[]
  ): Promise<Finding[]> =>
    Promise.resolve(
      (detect as unknown as (s: unknown, signal: AbortSignal) => Finding[])(segments, signal),
    );

  const byUrl = (url: string): Scores => (url.includes('VIOLENT') ? { violence: 0.9 } : {});

  function withImages(options: Partial<Parameters<typeof openaiModeration>[0]> = {}) {
    const stub = createModerationClient(byWord, { image: byUrl });
    const detect = openaiModeration({
      client: stub.client,
      model: 'omni-moderation-2024-09-26',
      images: true,
      ...options,
    });
    return { detect, ...stub };
  }

  it('does not take images unless asked', async () => {
    const { detect, images } = withImages({ images: false });

    expect(detect.images).toBeUndefined();
    expect(detect.only('violence').images).toBeUndefined();
    expect(images).toHaveLength(0);
  });

  it('rejects an images option that is not a boolean', () => {
    expect(() => withImages({ images: 'yes' as never })).toThrow(
      'openaiModeration: images must be a boolean',
    );
  });

  it('says it takes images, for the detector and every view of it', () => {
    const { detect } = withImages();

    expect(detect.images).toBe(true);
    expect(detect.only('violence').images).toBe(true);
  });

  it('sends each image alone, as a data URL, and labels what it flags with no span', async () => {
    const { detect, images, calls } = withImages();

    const found = await readAll(detect, picture('VIOLENT'), picture('calm'), picture('VIOLENT2'));

    expect(images.map((request) => request.url)).toEqual([
      'data:image/png;base64,VIOLENT',
      'data:image/png;base64,calm',
      'data:image/png;base64,VIOLENT2',
    ]);
    expect(images.every((request) => request.parts === 1)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(found).toEqual([
      { segment: 0, label: 'moderation.violence' },
      { segment: 2, label: 'moderation.violence' },
    ]);
  });

  it('reads texts and images of one call, and keeps each finding on its own segment', async () => {
    const { detect, images, calls } = withImages();

    const found = await readAll(detect, user('hate'), picture('VIOLENT'), user('fine'));

    expect(calls).toHaveLength(1);
    expect(images).toHaveLength(1);
    expect(found).toEqual([
      { segment: 0, label: 'moderation.hate' },
      { segment: 1, label: 'moderation.violence' },
    ]);
  });

  it('counts an image by its score when a threshold asks for it', async () => {
    const stub = createModerationClient(byWord, { image: () => ({ violence: 0.4 }) });
    const detect = openaiModeration({
      client: stub.client,
      model: 'pinned',
      images: true,
      thresholds: { violence: 0.3 },
    });

    expect(await readAll(detect, picture('x'))).toEqual([
      { segment: 0, label: 'moderation.violence' },
    ]);
  });

  it('asks once for an image however often it is given, in a call or across calls', async () => {
    const { detect, images } = withImages();

    await readAll(detect, picture('VIOLENT'), picture('VIOLENT'));
    await readAll(detect, picture('VIOLENT'));

    expect(images).toHaveLength(1);
  });

  it('reports what an image request cost', async () => {
    const onUsage = vi.fn();
    const { detect } = withImages({ onUsage });

    await readAll(detect, picture('calm'));

    expect(onUsage).toHaveBeenCalledWith({
      model: 'omni-moderation-2024-09-26',
      texts: 0,
      images: 1,
      ms: expect.any(Number),
    });
  });

  describe('an image the API cannot take', () => {
    const tiff = picture('AAAA', 'image/tiff');
    // Base64 of just over 20 MB of bytes.
    const huge = picture('A'.repeat(28 * 1024 * 1024));

    it('is an error by default, so the check decides, and nothing is sent', async () => {
      const { detect, images } = withImages();

      await expect(readAll(detect, tiff)).rejects.toThrow(
        'openaiModeration: the API takes PNG, JPEG, WebP and GIF images only',
      );
      await expect(readAll(detect, huge)).rejects.toThrow(
        'openaiModeration: the API takes images up to 20 MB',
      );
      expect(images).toHaveLength(0);
    });

    it('is counted as unscanned with skip, and the rest of the call is still read', async () => {
      const { detect, images } = withImages({ unsupportedImages: 'skip' });

      const found = await readAll(detect, tiff, picture('VIOLENT'), huge);

      expect(found).toEqual([
        { segment: 0, unscanned: true },
        { segment: 1, label: 'moderation.violence' },
        { segment: 2, unscanned: true },
      ]);
      expect(images).toHaveLength(1);
    });

    it('is passed on by every view, so it is counted whatever the categories', async () => {
      const { detect } = withImages({ unsupportedImages: 'skip' });

      expect(await readAll(detect.only('hate') as never, tiff)).toEqual([
        { segment: 0, unscanned: true },
      ]);
    });

    it('rejects an unknown mode', () => {
      expect(() => withImages({ unsupportedImages: 'maybe' as never })).toThrow(
        "openaiModeration: unsupportedImages must be 'error' or 'skip'",
      );
    });
  });

  it('throws when the API answers an image with the wrong number of results', async () => {
    const client: ModerationClient = {
      moderations: { create: async () => ({ results: [] }) },
    };
    const detect = openaiModeration({ client, model: 'pinned', images: true });

    await expect(readAll(detect, picture('x'))).rejects.toThrow(
      'openaiModeration: the API answered for the wrong number of images',
    );
  });
});
