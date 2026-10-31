import { describe, expect, it, vi } from 'vitest';

import {
  bedrockGuardrail,
  type BedrockGuardrailOptions,
  type CallView,
  type Segment,
} from '../../src/guardrail/index.js';
import { at, jpegImage, pngImage, stubbedClient, type ApplyGuardrailHandler } from '../helpers.js';

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

    it('stops a call that is aborted at once, while another call keeps the shared request going', async () => {
      let finish!: () => void;
      const { detect, requests, signals } = setup({}, async (input) => {
        await new Promise<void>((resolve) => (finish = resolve));
        return answer(textOf(input));
      });
      const text = [user(`${EMAIL} stocks`)];
      const first = new AbortController();

      const gone = detect.only('pii')(text, first.signal);
      const kept = detect.only('topic')(text, new AbortController().signal);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await later(5);

      first.abort(new Error('first gave up'));

      // It does not wait for the request, which is still going for the other call.
      await expect(gone).rejects.toThrow('first gave up');
      expect(signals[0]!.aborted).toBe(false);

      finish();
      await expect(kept).resolves.toEqual([{ segment: 0, label: 'topic.Investing' }]);
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

  describe('images', () => {
    const violent = {
      contentPolicy: { filters: [{ type: 'VIOLENCE', action: 'BLOCKED', detected: true }] },
    };
    const picture = (
      image: { data: string; mimeType: string },
      source: Segment['source'] = 'user',
    ) => ({ image: { data: image.data, mimeType: image.mimeType }, source }) as unknown as Segment;
    const formatOf = (input: Parameters<ApplyGuardrailHandler>[0]) =>
      at(input.content ?? [], 0).image?.format;
    /** A guardrail that finds violence in every PNG and nothing in anything else. */
    const imageHandler: ApplyGuardrailHandler = async (input) =>
      at(input.content ?? [], 0).image
        ? { assessments: formatOf(input) === 'png' ? [violent] : [] }
        : answer(textOf(input));
    const withImages = (options: Partial<BedrockGuardrailOptions> = {}) =>
      setup({ images: true, ...options }, imageHandler);

    it('are off unless asked: the detector says nothing about images, and refuses one', async () => {
      const { detect, requests, signal } = setup();

      expect(detect.images).toBeUndefined();
      expect(detect.only('content').images).toBeUndefined();
      await expect(detect([picture(pngImage())], signal)).rejects.toThrow(
        'bedrockGuardrail: images are off, set images: true',
      );
      expect(requests).toHaveLength(0);
    });

    it('say they are taken, for the detector and every view of it', () => {
      const { detect } = withImages();

      expect(detect.images).toBe(true);
      expect(detect.only('content').images).toBe(true);
      expect(detect.grounding().images).toBeUndefined();
    });

    it('go as one request each, with the format and the bytes, next to the texts', async () => {
      const { detect, requests, signal } = withImages();
      const png = pngImage();
      const jpeg = jpegImage();

      const found = await detect(
        [user('hello'), picture(png), picture(jpeg, 'assistant'), picture(png, 'output')],
        signal,
      );

      expect(requests.map(({ source, content }) => [source, Object.keys(at(content!, 0))])).toEqual(
        [
          ['INPUT', ['text']],
          ['INPUT', ['image']],
          ['INPUT', ['image']],
          ['OUTPUT', ['image']],
        ],
      );
      expect(at(requests, 1).content).toEqual([
        { image: { format: 'png', source: { bytes: png.bytes } } },
      ]);
      expect(formatOf(at(requests, 2))).toBe('jpeg');
      // The same image from the same source is asked once. The jpeg finds nothing.
      expect(found).toEqual([
        { segment: 1, label: 'content.VIOLENCE' },
        { segment: 3, label: 'content.VIOLENCE' },
      ]);
    });

    it('have no span, and a view of other kinds does not see their findings', async () => {
      const { detect, signal } = withImages();

      expect(await detect.only('pii')([picture(pngImage())], signal)).toEqual([]);
      expect(await detect.only('content')([picture(pngImage())], signal)).toEqual([
        { segment: 0, label: 'content.VIOLENCE' },
      ]);
    });

    it('are asked once however often they come back, since they are keyed by their data', async () => {
      const { detect, requests, signal } = withImages();
      const png = pngImage();

      await detect([picture(png), picture(png)], signal);
      await detect([picture(png)], signal);
      await detect([picture(pngImage(65, 64))], signal);

      expect(requests).toHaveLength(2);
    });

    it('are capped apart from text by imageConcurrency, within concurrency', async () => {
      let active = 0;
      let peakImages = 0;
      let peak = 0;
      let images = 0;
      const { detect, signal } = setup(
        { images: true, concurrency: 3, imageConcurrency: 1 },
        async (input) => {
          const isImage = at(input.content ?? [], 0).image !== undefined;
          active += 1;
          images += isImage ? 1 : 0;
          peak = Math.max(peak, active);
          peakImages = Math.max(peakImages, images);
          await later(10);
          active -= 1;
          images -= isImage ? 1 : 0;
          return { assessments: [] };
        },
      );

      await detect(
        [1, 2, 3, 4].map((width) => picture(pngImage(width, 8))).concat(['a', 'b'].map(user)),
        signal,
      );

      expect(peakImages).toBe(1);
      expect(peak).toBe(3);
    });

    describe('that Bedrock cannot take', () => {
      const tooBig = pngImage(64, 64, 4 * 1024 * 1024);
      const refused: [string, Segment, string][] = [
        [
          'a format other than PNG or JPEG',
          picture({ data: 'AAAA', mimeType: 'image/webp' }),
          'takes PNG and JPEG images only',
        ],
        [
          'data that is not base64',
          picture({ data: '!!!', mimeType: 'image/png' }),
          'the image is not valid base64',
        ],
        ['more than 4 MB', picture(tooBig), 'takes images up to 4 MB'],
        ['a PNG wider than 8000', picture(pngImage(8001, 10)), 'up to 8000 by 8000 pixels'],
        ['a PNG taller than 8000', picture(pngImage(10, 8001)), 'up to 8000 by 8000 pixels'],
        ['a JPEG taller than 8000', picture(jpegImage(10, 8001)), 'up to 8000 by 8000 pixels'],
        [
          'a PNG without its signature',
          picture({ data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA', mimeType: 'image/png' }),
          'not a readable PNG',
        ],
        [
          'a PNG that stops early',
          picture({ data: pngImage().data.slice(0, 20), mimeType: 'image/png' }),
          'not a readable PNG',
        ],
        [
          'a JPEG without its start',
          picture({ data: 'AAAAAAAAAAAAAAAAAAAAAAAA', mimeType: 'image/jpeg' }),
          'not a readable JPEG',
        ],
        [
          'a JPEG with a stray byte where a marker belongs',
          picture({
            data: Buffer.from([0xff, 0xd8, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
            mimeType: 'image/jpeg',
          }),
          'not a readable JPEG',
        ],
      ];

      it.each(refused)(
        'fails the check for %s, before any request, and never quotes the data',
        async (_name, segment, why) => {
          const { detect, requests, signal } = withImages();

          const error = await Promise.resolve(detect([segment], signal)).catch(
            (caught: Error) => caught,
          );

          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain(`bedrockGuardrail: `);
          expect((error as Error).message).toContain(why);
          expect((error as Error).message).not.toContain('AAAA');
          expect(requests).toHaveLength(0);
        },
      );

      it.each(refused)(
        'counts %s as unscanned with unsupportedImages: skip',
        async (_name, segment) => {
          const { detect, requests, signal } = withImages({ unsupportedImages: 'skip' });

          const found = await detect([segment], signal);

          expect(found).toEqual([{ segment: 0, unscanned: true }]);
          // A view of some kinds still says an image was not read.
          expect(await detect.only('pii')([segment], signal)).toEqual([
            { segment: 0, unscanned: true },
          ]);
          expect(requests).toHaveLength(0);
        },
      );

      it('takes a JPEG that has tables before its frame, and an uppercase type', async () => {
        const { detect, requests, signal } = withImages();
        // SOI, a DHT segment of 4 bytes (C4), then the frame (C0) of 20 by 30.
        const bytes = [
          0xff, 0xd8, 0xff, 0xc4, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 30, 0, 20, 0, 0, 0, 0,
        ];
        const data = Buffer.from(bytes).toString('base64');

        await detect([picture({ data, mimeType: 'IMAGE/JPG' })], signal);

        expect(formatOf(at(requests, 0))).toBe('jpeg');
      });

      it('fails the check for a JPEG whose segments run past its end', async () => {
        const { detect, signal } = withImages();
        const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xe1, 0, 2, 0, 0]).toString(
          'base64',
        );

        await expect(detect([picture({ data, mimeType: 'image/jpeg' })], signal)).rejects.toThrow(
          'not a readable JPEG',
        );
      });

      it('stops the requests still waiting for a slot', async () => {
        const { detect, requests, signal } = withImages({ concurrency: 1 });
        const tiff = picture({ data: 'AAAA', mimeType: 'image/tiff' });

        await expect(detect([user('a'), user('b'), tiff], signal)).rejects.toThrow('PNG and JPEG');

        expect(requests).toHaveLength(1);
      });
    });
  });

  describe('grounding', () => {
    const answer = (text: string, source: Segment['source'] = 'output'): Segment => ({
      text,
      source,
    });
    const verdict = (...types: string[]) => ({
      assessments: [
        {
          contextualGroundingPolicy: {
            filters: types.map((type) => ({ type, action: 'BLOCKED', detected: true })),
          },
          sensitiveInformationPolicy: email.sensitiveInformationPolicy,
        },
      ],
    });
    const callOf = (input: Segment[]): CallView => ({ input });
    const ctx = callOf([
      { text: 'Paris is the capital of France.', source: 'tool' },
      { text: 'Madrid is the capital of Spain.', source: 'tool' },
      { text: 'earlier question', source: 'user' },
      { text: 'What is the capital of France?', source: 'user' },
      { text: 'a system rule', source: 'system' },
    ]);
    /** Ungrounded when the answer says "Lyon". */
    const judge: ApplyGuardrailHandler = async (input) => {
      const guarded = at(input.content ?? [], (input.content ?? []).length - 1);
      return guarded.text?.text?.includes('Lyon') ? verdict('GROUNDING') : { assessments: [] };
    };

    it('says it reads the call, and a plain view does not', () => {
      const { detect } = setup();

      expect(detect.grounding().callView).toBe(true);
      expect(detect.callView).toBeUndefined();
      expect(detect.only('topic').callView).toBeUndefined();
    });

    it('sends each tool result as a source, the last question, and the answer unqualified', async () => {
      const { detect, requests, signal } = setup({}, judge);

      await detect.grounding()([answer('It is Paris.')], signal, ctx);

      expect(requests).toEqual([
        {
          guardrailIdentifier: 'gr-abc',
          guardrailVersion: '3',
          source: 'OUTPUT',
          content: [
            { text: { text: 'Paris is the capital of France.', qualifiers: ['grounding_source'] } },
            { text: { text: 'Madrid is the capital of Spain.', qualifiers: ['grounding_source'] } },
            { text: { text: 'What is the capital of France?', qualifiers: ['query'] } },
            { text: { text: 'It is Paris.' } },
          ],
        },
      ]);
    });

    it('finds the answer ungrounded over the whole answer, and nothing when it is grounded', async () => {
      const { detect, signal } = setup({}, judge);
      const grounding = detect.grounding();

      expect(await grounding([answer('It is Lyon.')], signal, ctx)).toEqual([
        { segment: 0, label: 'grounding.GROUNDING', start: 0, end: 11 },
      ]);
      expect(await grounding([answer('It is Paris.')], signal, ctx)).toEqual([]);
    });

    it('labels relevance as well, and reads no other policy of the same response', async () => {
      const { detect, signal } = setup({}, async () => verdict('GROUNDING', 'RELEVANCE'));

      const found = await detect.grounding()([answer(`Mail ${EMAIL}`)], signal, ctx);

      expect(found.map(({ label }) => label)).toEqual([
        'grounding.GROUNDING',
        'grounding.RELEVANCE',
      ]);
    });

    it('judges a long answer in chunks of 5000, each against the same context, with its own span', async () => {
      const { detect, requests, signal } = setup({}, async (input) => {
        const guarded = at(input.content ?? [], (input.content ?? []).length - 1).text?.text ?? '';
        return guarded.startsWith('x') ? verdict('GROUNDING') : { assessments: [] };
      });
      const text = `${'x'.repeat(5000)}${'y'.repeat(5000)}${'x'.repeat(2000)}`;

      const found = await detect.grounding()([answer(text)], signal, ctx);

      expect(requests).toHaveLength(3);
      expect(requests.map((request) => at(request.content ?? [], 3).text?.text?.length)).toEqual([
        5000, 5000, 2000,
      ]);
      expect(found).toEqual([
        { segment: 0, label: 'grounding.GROUNDING', start: 0, end: 5000 },
        { segment: 0, label: 'grounding.GROUNDING', start: 10_000, end: 12_000 },
      ]);
    });

    it('takes the sources it is told to, and the last non blank question', async () => {
      const { detect, requests, signal } = setup({}, judge);
      const call = callOf([
        { text: 'a rule', source: 'system' },
        { text: 'tool result', source: 'tool' },
        { text: 'the question', source: 'user' },
        { text: '  ', source: 'user' },
      ]);

      await detect.grounding({ sources: ['system', 'user'] })([answer('ok')], signal, call);

      expect(at(requests, 0).content).toEqual([
        { text: { text: 'a rule', qualifiers: ['grounding_source'] } },
        { text: { text: 'the question', qualifiers: ['grounding_source'] } },
        { text: { text: 'the question', qualifiers: ['query'] } },
        { text: { text: 'ok' } },
      ]);
    });

    it('sends no question when the user asked none', async () => {
      const { detect, requests, signal } = setup({}, judge);

      await detect.grounding()([answer('ok')], signal, callOf([{ text: 'fact', source: 'tool' }]));

      expect(at(requests, 0).content).toEqual([
        { text: { text: 'fact', qualifiers: ['grounding_source'] } },
        { text: { text: 'ok' } },
      ]);
    });

    it('checks nothing without a source: no request and no finding', async () => {
      const { detect, requests, signal } = setup({}, judge);
      const grounding = detect.grounding();

      expect(await grounding([answer('It is Lyon.')], signal, callOf([]))).toEqual([]);
      expect(
        await grounding([answer('It is Lyon.')], signal, callOf([{ text: ' ', source: 'tool' }])),
      ).toEqual([]);
      expect(requests).toHaveLength(0);
    });

    it('sends the last 1000 characters of a longer question, or fails the check', async () => {
      const { detect, requests, signal } = setup({}, judge);
      const question = `${'a'.repeat(50)}${'b'.repeat(1000)}`;
      const call = callOf([
        { text: 'fact', source: 'tool' },
        { text: question, source: 'user' },
      ]);

      await detect.grounding()([answer('ok')], signal, call);
      expect(at(at(requests, 0).content ?? [], 1).text?.text).toBe('b'.repeat(1000));

      await detect.grounding()(
        [answer('ok')],
        signal,
        callOf([
          { text: 'fact', source: 'tool' },
          { text: 'c'.repeat(1000), source: 'user' },
        ]),
      );
      expect(at(at(requests, 1).content ?? [], 1).text?.text).toHaveLength(1000);

      await expect(
        detect.grounding({ queryOverflow: 'error' })([answer('ok')], signal, call),
      ).rejects.toThrow('bedrockGuardrail: the question is over 1000 characters');
    });

    it('fails the check when the sources are over 100000 characters', async () => {
      const { detect, requests, signal } = setup({}, judge);
      const call = callOf([
        { text: 'x'.repeat(60_000), source: 'tool' },
        { text: 'y'.repeat(40_001), source: 'tool' },
      ]);

      await expect(detect.grounding()([answer('ok')], signal, call)).rejects.toThrow(
        'bedrockGuardrail: the grounding sources are over 100000 characters',
      );
      expect(requests).toHaveLength(0);
    });

    it('is an error without the call, since only an output check is given one', async () => {
      const { detect, requests, signal } = setup({}, judge);

      await expect(detect.grounding()([answer('ok')], signal)).rejects.toThrow(
        'bedrockGuardrail: grounding reads the call, so it only runs as an output check',
      );
      expect(requests).toHaveLength(0);
    });

    it('asks once for the same sources, question and answer, and again when any of them changes', async () => {
      const { detect, requests, signal } = setup({}, judge);
      const grounding = detect.grounding();

      await grounding([answer('It is Lyon.')], signal, ctx);
      await grounding([answer('It is Lyon.')], signal, callOf([...ctx.input]));
      expect(requests).toHaveLength(1);

      await grounding([answer('It is Lyon.')], signal, callOf([...ctx.input.slice(1)]));
      await grounding([answer('It is Lyon!')], signal, ctx);
      await grounding(
        [answer('It is Lyon.')],
        signal,
        callOf([...ctx.input, { text: 'more', source: 'user' }]),
      );
      expect(requests).toHaveLength(4);
    });

    it('never mixes up with a plain check of the same text', async () => {
      const { detect, requests, signal } = setup({}, judge);

      await detect([answer('It is Lyon.')], signal);
      await detect.grounding()([answer('It is Lyon.')], signal, ctx);

      expect(requests).toHaveLength(2);
    });

    it('is not cached for a DRAFT guardrail', async () => {
      const { detect, requests, signal } = setup({ guardrailVersion: 'DRAFT' }, judge);

      await detect.grounding()([answer('ok')], signal, ctx);
      await detect.grounding()([answer('ok')], signal, ctx);

      expect(requests).toHaveLength(2);
    });

    it('does not ask about a blank answer', async () => {
      const { detect, requests, signal } = setup({}, judge);

      expect(await detect.grounding()([answer('  ')], signal, ctx)).toEqual([]);
      expect(requests).toHaveLength(0);
    });

    it.each([
      [
        { sources: [] },
        'grounding sources must be a non empty list of user, tool, system or assistant',
      ],
      [
        { sources: ['output'] },
        'grounding sources must be a non empty list of user, tool, system or assistant',
      ],
      [
        { sources: 'tool' },
        'grounding sources must be a non empty list of user, tool, system or assistant',
      ],
      [{ queryOverflow: 'cut' }, "queryOverflow must be 'tail' or 'error'"],
    ])('refuses %j', (bad, message) => {
      const { detect } = setup();

      expect(() => detect.grounding(bad as never)).toThrow(`bedrockGuardrail: ${message}`);
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
      [{ images: 'yes' }, 'bedrockGuardrail: images must be a boolean'],
      [
        { unsupportedImages: 'maybe' },
        "bedrockGuardrail: unsupportedImages must be 'error' or 'skip'",
      ],
      [
        { imageConcurrency: 0 },
        'bedrockGuardrail: imageConcurrency must be an integer of at least 1',
      ],
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
          images: true,
          unsupportedImages: 'skip',
          imageConcurrency: 2,
        } as never),
      ).not.toThrow();
    });
  });
});
