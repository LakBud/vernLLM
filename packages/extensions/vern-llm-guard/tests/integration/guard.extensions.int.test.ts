import { VernLLM, type StreamChunk, type VernLLMMiddleware, type VernLLMOptions } from 'vern-llm';
import { bedrockGuardrail } from 'vern-llm-bedrock/guardrail';
import { loggerMiddleware, memorySink } from 'vern-llm-logger';
import { policyMiddleware } from 'vern-llm-policy';
import { usageBudgetShare, usageMiddleware } from 'vern-llm-usage';
import { describe, expect, it } from 'vitest';

import {
  guardLabels,
  guardLogFields,
  llmClassifier,
  openaiModeration,
  patterns,
} from '../../src/index.js';
import {
  captureLogger,
  classifierResponder,
  createClassifierLLM,
  createGuardrailClient,
  createModerationClient,
  createResponderClient,
  createStreamClient,
  harness,
  lastUserText,
  textDeltas,
  tokenIn,
  type Assessments,
  type Found,
  type Scores,
} from '../helpers.js';

// The real logger, usage and policy around the guard, as a service would run them. The guard
// imports none of them: they are dev dependencies of this test only. The same goes for
// vern-llm-bedrock's guardrail detector.

const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };
const withEmail = { ...call, userContent: 'Write to jane@acme.com please' };
const withKey = { ...call, userContent: 'My key is AKIAIOSFODNN7EXAMPLE' };

const pii = { id: 'pii', detect: patterns(['email']) };
const secrets = { id: 'secrets', detect: patterns(['secrets']), action: 'block' as const };

function setup(checks = [pii, secrets], budget = false, vern: Partial<VernLLMOptions> = {}) {
  const sink = memorySink();
  const logger = loggerMiddleware({ sink, logger: 'silent', enrich: guardLogFields });
  const shares: (number | undefined)[] = [];
  const reader: VernLLMMiddleware = {
    name: 'reader',
    position: 1,
    wrap: (_request, next, ctx) => {
      shares.push(usageBudgetShare(ctx));
      return next();
    },
  };
  const policy = policyMiddleware({
    logger: 'silent',
    targets: { primary: { zdr: false }, b: { zdr: true } },
    labels: guardLabels,
    rules: [{ id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } }],
  });
  const usage = usageMiddleware({
    prices: { 'primary-model': { input: 1, output: 1 }, 'b-model': { input: 1, output: 1 } },
    pricesAsOf: new Date().toISOString().slice(0, 10),
    attribute: ['tenantId'],
    ...(budget && { budgets: [{ key: 'tenantId', limitUsd: 1, per: 'day' as const }] }),
    logger: 'silent',
  });
  const built = harness(
    { checks },
    { ...vern, defaultMaxTokens: 1000, middleware: [logger, policy, usage, reader] },
  );
  const records = () => sink.entries.map((entry) => entry.entry).filter((e) => e.kind === 'call');
  return { ...built, logger, shares, records };
}

describe('with policy', () => {
  it('sends a call with pii only to the targets that keep nothing', async () => {
    const { llm, primary, b, logger } = setup();

    await llm.call(withEmail);

    expect(primary.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
    logger.dispose();
  });

  it('leaves a call with nothing found on the first target', async () => {
    const { llm, primary, logger } = setup();

    await llm.call(call);

    expect(primary.calls).toHaveLength(1);
    logger.dispose();
  });
});

describe('with usage', () => {
  it('reserves no budget for a blocked call', async () => {
    const used = setup([pii, secrets], true);
    const fresh = setup([pii, secrets], true);

    await expect(used.llm.call(withKey)).rejects.toMatchObject({ code: 'content_blocked' });
    await used.llm.call(call);
    await fresh.llm.call(call);

    expect(used.shares).toHaveLength(1);
    expect(used.shares).toEqual(fresh.shares);
    expect(used.primary.calls).toHaveLength(1);
    used.logger.dispose();
    fresh.logger.dispose();
  });
});

describe('with the logger', () => {
  it('records a blocked call as rejected, with the guard result on it', async () => {
    const { llm, records, logger } = setup();

    await expect(llm.call(withKey)).rejects.toMatchObject({ code: 'content_blocked' });

    const [record] = records();
    expect(record).toMatchObject({ outcome: 'rejected' });
    expect(JSON.stringify(record)).toContain('guard.result');
    expect(JSON.stringify(record)).not.toContain('AKIA');
    logger.dispose();
  });

  it('carries the outcome and labels of a call that went through', async () => {
    const { llm, records, logger } = setup();

    await llm.call(withEmail);

    const [record] = records();
    expect(JSON.stringify(record)).toContain('guard_outcome');
    expect(JSON.stringify(record)).toContain('guard_labels');
    expect(JSON.stringify(record)).not.toContain('jane@acme.com');
    logger.dispose();
  });

  it('carries the guard summary of a stream once it has ended', async () => {
    const { client } = createStreamClient(textDeltas('all done', 4));
    const { llm, records, logger } = setup([pii, secrets], false, { client });

    const stream = (await llm.call({ ...call, stream: true })) as unknown as {
      chunks: AsyncIterable<StreamChunk>;
      finalResult: Promise<unknown>;
    };
    for await (const _chunk of stream.chunks) void _chunk;
    await stream.finalResult;

    expect(JSON.stringify(records()[0])).toContain('guard_outcome');
    logger.dispose();
  });
});

describe('with openaiModeration', () => {
  const scoreOf = (text: string): Scores => ({
    ...(text.includes('hurt myself') && { 'self-harm/intent': 0.97 }),
    ...(text.includes('fight') && { violence: 0.8 }),
  });
  const hurt = { ...call, userContent: 'I want to hurt myself' };
  const fight = { ...call, userContent: 'Describe the fight' };

  function moderated(
    behavior: Parameters<typeof createModerationClient>[1] = {},
    guard: Partial<Parameters<typeof harness>[0]> = {},
  ) {
    const moderation = createModerationClient(scoreOf, behavior);
    const detector = openaiModeration({
      client: moderation.client,
      model: 'omni-moderation-2024-09-26',
    });
    const policy = policyMiddleware({
      logger: 'silent',
      targets: { primary: { zdr: false }, b: { zdr: true } },
      labels: guardLabels,
      rules: [{ id: 'harm-zdr', forbid: { zdr: false }, when: { labels: 'harm' } }],
    });
    const built = harness(
      {
        checks: [
          {
            id: 'self-harm',
            detect: detector.only('self-harm', 'self-harm/intent', 'self-harm/instructions'),
            action: 'block',
            on: ['user', 'output'],
          },
          { id: 'harm', detect: detector.only('violence', 'hate'), on: ['user', 'output'] },
        ],
        ...guard,
      },
      { middleware: [policy] },
    );
    return { ...built, moderation };
  }

  it('blocks a self harm finding before any provider is contacted', async () => {
    const { llm, primary, b, moderation } = moderated();

    await expect(llm.call(hurt)).rejects.toMatchObject({ code: 'content_blocked' });

    expect(primary.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
    expect(moderation.calls).toHaveLength(1);
  });

  it('labels a violence finding, and policy sends the call to the target that keeps nothing', async () => {
    const { llm, primary, b } = moderated();

    await llm.call(fight);

    expect(primary.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
  });

  it('leaves a call with nothing found on the first target', async () => {
    const { llm, primary, b } = moderated();

    await llm.call(call);

    expect(primary.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it('asks once for a text however many checks read it, and not again on the next call', async () => {
    const { llm, moderation } = moderated();

    await llm.call(fight);
    await llm.call(fight);
    await llm.call(call);

    // Two checks read each text and cost one request. The answers are checked as well: 'b' from the
    // target policy chose, and 'primary'. The second `fight` call asked for neither its text nor
    // its answer again.
    expect(moderation.calls.map((request) => request.input)).toEqual([
      ['Describe the fight'],
      ['b'],
      ['hi'],
      ['primary'],
    ]);
  });

  it('checks the answer too, and blocks one that is flagged', async () => {
    const { llm } = moderated();
    const { llm: flagged } = harness(
      {
        checks: [
          {
            id: 'self-harm',
            detect: openaiModeration({
              client: createModerationClient(scoreOf).client,
              model: 'pinned',
            }).only('self-harm/intent'),
            action: 'block',
            on: 'output',
          },
        ],
      },
      {},
      { primary: () => 'you could hurt myself with it' },
    );

    await expect(llm.call(call)).resolves.toBe('primary');
    await expect(flagged.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
  });

  it('refuses the call when moderation is down, unless the check fails open', async () => {
    const down = new Error('moderation down');
    const closed = moderated({ error: down });
    await expect(closed.llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
    expect(closed.primary.calls).toHaveLength(0);

    const open = moderated({ error: down }, { onError: 'open' });
    await expect(open.llm.call(call)).resolves.toBe('primary');
  });

  it('cancels the request when the check runs out of time, and then follows onError', async () => {
    const moderation = createModerationClient(scoreOf, { delayMs: 500 });
    const { llm, primary } = harness({
      checks: [
        {
          id: 'slow',
          detect: openaiModeration({ client: moderation.client, model: 'pinned' }),
          action: 'block',
          timeoutMs: 30,
        },
      ],
    });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });

    expect(primary.calls).toHaveLength(0);
    expect(moderation.calls).toHaveLength(1);
    expect(moderation.calls[0]!.signal!.aborted).toBe(true);
  });

  it('blocks rather than redact a finding that has no position', async () => {
    const moderation = createModerationClient(scoreOf);
    const { llm, primary } = harness({
      checks: [
        {
          id: 'fight',
          detect: openaiModeration({ client: moderation.client, model: 'pinned' }).only('violence'),
          action: 'redact',
        },
      ],
    });

    await expect(llm.call(fight)).rejects.toMatchObject({ code: 'content_blocked' });
    expect(primary.calls).toHaveLength(0);
  });

  it('counts a score under the flag when the check sets a threshold, and policy routes on it', async () => {
    // 0.4 is not flagged by OpenAI, but this app treats anything from 0.3 as harm.
    const moderation = createModerationClient((text) =>
      text.includes('maybe') ? { violence: 0.4 } : {},
    );
    const detector = openaiModeration({
      client: moderation.client,
      model: 'pinned',
      thresholds: { violence: 0.3 },
    });
    const { llm, primary, b } = harness(
      { checks: [{ id: 'harm', detect: detector.only('violence') }] },
      {
        middleware: [
          policyMiddleware({
            logger: 'silent',
            targets: { primary: { zdr: false }, b: { zdr: true } },
            labels: guardLabels,
            rules: [{ id: 'harm-zdr', forbid: { zdr: false }, when: { labels: 'harm' } }],
          }),
        ],
      },
    );

    await llm.call({ ...call, userContent: 'maybe a fight' });

    expect(primary.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
  });

  it('checks a long text in chunks, and blocks on what only the last chunk says', async () => {
    const moderation = createModerationClient(scoreOf);
    const { llm, primary } = harness({
      checks: [
        {
          id: 'harm',
          detect: openaiModeration({
            client: moderation.client,
            model: 'pinned',
            chunkChars: 1000,
            overlapChars: 0,
          }).only('violence'),
          action: 'block',
        },
      ],
    });
    const long = `${'calm words '.repeat(200)}Describe the fight`;

    await expect(llm.call({ ...call, userContent: long })).rejects.toMatchObject({
      code: 'content_blocked',
    });

    expect(primary.calls).toHaveLength(0);
    expect(moderation.calls).toHaveLength(1);
    expect(moderation.calls[0]!.input.length).toBeGreaterThan(1);
  });

  it('moderates the system prompt and the user text of one call in a single request', async () => {
    const moderation = createModerationClient(scoreOf);
    const { llm } = harness({
      checks: [
        {
          id: 'harm',
          detect: openaiModeration({ client: moderation.client, model: 'pinned' }),
          on: ['user', 'system'],
        },
      ],
    });

    await llm.call({ ...call, systemPrompt: 'You are a calm assistant', userContent: 'hello' });

    expect(moderation.calls).toHaveLength(1);
    expect([...moderation.calls[0]!.input].sort()).toEqual(['You are a calm assistant', 'hello']);
  });
});

describe('with llmClassifier', () => {
  const categories = {
    investment_advice: 'Recommends buying or selling a specific security',
    competitor: 'Names a competitor',
  };
  const decide = (text: string): Found => ({
    ...(text.includes('buy NVDA') && { investment_advice: ['buy NVDA'] }),
    ...(text.includes('Acme') && { competitor: ['Acme'] }),
  });

  /** A real `VernLLM` of its own over a stub client, as the classifier's model. */
  function judge(decided = decide) {
    const stub = createResponderClient(classifierResponder(decided));
    const model = new VernLLM({
      client: stub.client,
      model: 'judge',
      maxRetries: 0,
      logger: 'silent',
    });
    return { model, calls: stub.calls, texts: () => stub.calls.map(lastUserText) };
  }

  /** What the judge was asked to classify, from the boundary of each of its calls. */
  const classified = (calls: ReturnType<typeof judge>['calls']): string[] =>
    calls.flatMap((params) => {
      const content = lastUserText(params);
      return [...content.matchAll(/<t_[0-9a-f]{6} id="\d+">\n([\s\S]*?)\n<\/t_[0-9a-f]{6}>/g)].map(
        (match) => match[1]!,
      );
    });

  function judged(
    guard: Partial<Parameters<typeof harness>[0]> = {},
    answers: Parameters<typeof harness>[2] = {},
    decided = decide,
  ) {
    const model = judge(decided);
    const classifier = llmClassifier({ llm: model.model, categories, quotes: true });
    const built = harness(
      {
        checks: [
          {
            id: 'advice',
            detect: classifier.only('investment_advice'),
            action: 'block',
            on: 'output',
          },
          {
            id: 'competitor',
            detect: classifier.only('competitor'),
            action: 'redact',
            on: 'output',
          },
        ],
        ...guard,
      },
      {},
      answers,
    );
    return { ...built, judged: model };
  }

  it('blocks an answer with investment advice', async () => {
    const {
      llm,
      primary,
      judged: model,
    } = judged({}, { primary: () => 'You should buy NVDA today' });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });

    expect(primary.calls).toHaveLength(1);
    expect(classified(model.calls)).toEqual(['You should buy NVDA today']);
  });

  it('masks a competitor in the answer, from the quote the model gave', async () => {
    const { llm } = judged({}, { primary: () => 'Try Acme instead, or ask us' });

    const answer = await llm.call(call);

    expect(answer).not.toContain('Acme');
    expect(answer).toContain('instead, or ask us');
  });

  it('asks the model once for an answer however many checks read it, and leaves a clean one alone', async () => {
    const { llm, judged: model } = judged({}, { primary: () => 'We can help with that' });

    await expect(llm.call(call)).resolves.toBe('We can help with that');

    expect(model.calls).toHaveLength(1);
  });

  it('does not ask again for the history of a conversation', async () => {
    const model = judge();
    const classifier = llmClassifier({ llm: model.model, categories });
    const { llm } = harness({
      checks: [{ id: 'topic', detect: classifier.only('competitor'), on: ['user', 'output'] }],
    });

    await llm.call({ ...call, userContent: 'hello' });
    await llm.call({
      ...call,
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'primary' },
      ],
      userContent: 'and then?',
    });

    // The first turn's question and answer, then only what is new: the history is not sent again,
    // and the second answer is the same text as the first, from the same source.
    expect(classified(model.calls).sort()).toEqual(['and then?', 'hello', 'primary']);
  });

  it('redacts a competitor in the request for the provider and puts it back in the answer', async () => {
    const model = judge();
    const classifier = llmClassifier({ llm: model.model, categories, quotes: true });
    const { llm, primary } = harness(
      {
        checks: [
          { id: 'competitor', detect: classifier.only('competitor'), action: 'redact', on: 'user' },
        ],
      },
      {},
      { primary: (params) => `I heard about ${tokenIn(params)}` },
    );

    const answer = await llm.call({ ...call, userContent: 'Is Acme any good?' });

    expect(lastUserText(primary.calls[0]!)).not.toContain('Acme');
    expect(answer).toBe('I heard about Acme');
  });

  it('blocks rather than redact a quote it cannot find in the text', async () => {
    const { llm, primary } = judged({
      checks: [
        {
          id: 'competitor',
          detect: llmClassifier({
            llm: judge(() => ({ competitor: ['Globex'] })).model,
            categories,
            quotes: true,
          }).only('competitor'),
          action: 'redact',
        },
      ],
    });

    await expect(llm.call({ ...call, userContent: 'Is Acme any good?' })).rejects.toMatchObject({
      code: 'content_blocked',
    });
    expect(primary.calls).toHaveLength(0);
  });

  it('blocks rather than redact a finding when it did not ask for quotes', async () => {
    const model = judge();
    const { llm, primary } = harness({
      checks: [
        {
          id: 'competitor',
          detect: llmClassifier({ llm: model.model, categories }).only('competitor'),
          action: 'redact',
        },
      ],
    });

    await expect(llm.call({ ...call, userContent: 'Is Acme any good?' })).rejects.toMatchObject({
      code: 'content_blocked',
    });
    expect(primary.calls).toHaveLength(0);
  });

  it('refuses the call when the model is down, unless the check fails open', async () => {
    const down = createClassifierLLM(decide, { error: new Error('model down') });
    const checks = [
      {
        id: 'topic',
        detect: llmClassifier({ llm: down.llm, categories }),
        action: 'block' as const,
      },
    ];

    const closed = harness({ checks });
    await expect(closed.llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
    expect(closed.primary.calls).toHaveLength(0);

    const open = harness({ checks, onError: 'open' });
    await expect(open.llm.call(call)).resolves.toBe('primary');
  });

  it('cancels the model call when the check runs out of time, and then follows onError', async () => {
    const slow = createClassifierLLM(decide, { delayMs: 500 });
    const { llm, primary } = harness({
      checks: [
        {
          id: 'slow',
          detect: llmClassifier({ llm: slow.llm, categories }),
          action: 'block',
          timeoutMs: 30,
        },
      ],
    });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });

    expect(primary.calls).toHaveLength(0);
    expect(slow.calls[0]!.params.signal!.aborted).toBe(true);
  });

  it('refuses a classifier that was given the VernLLM the guard protects, and says why once', async () => {
    const log = captureLogger();
    let guarded: VernLLM | undefined;
    const classifier = llmClassifier({
      llm: { call: (params) => guarded!.call(params as never) },
      categories,
    });
    const built = harness({
      checks: [{ id: 'topic', detect: classifier.only('competitor'), action: 'block' }],
      logger: log.logger,
    });
    guarded = built.llm;

    // No loop: the classifier's call is refused at once, the check cannot answer, and onError
    // closed blocks the call.
    await expect(built.llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
    await expect(built.llm.call({ ...call, userContent: 'again' })).rejects.toMatchObject({
      code: 'content_blocked',
    });

    expect(built.primary.calls).toHaveLength(0);
    const warned = log
      .warnings()
      .filter((line) => line.includes('Give llmClassifier its own VernLLM'));
    expect(warned).toHaveLength(1);
  });

  it('lets the call through when that check fails open, and still says why', async () => {
    const log = captureLogger();
    let guarded: VernLLM | undefined;
    const classifier = llmClassifier({
      llm: { call: (params) => guarded!.call(params as never) },
      categories,
    });
    const built = harness({
      checks: [{ id: 'topic', detect: classifier, onError: 'open' }],
      logger: log.logger,
    });
    guarded = built.llm;

    await expect(built.llm.call(call)).resolves.toBe('primary');

    expect(log.warnings().some((line) => line.includes('Give llmClassifier its own VernLLM'))).toBe(
      true,
    );
  });
});

describe('with bedrockGuardrail', () => {
  const EMAIL = 'jane@acme.com';
  const assess = (text: string): Assessments => [
    ...(text.includes(EMAIL)
      ? [
          {
            sensitiveInformationPolicy: {
              piiEntities: [{ type: 'EMAIL', match: EMAIL, action: 'ANONYMIZED', detected: true }],
            },
          },
        ]
      : []),
    ...(text.includes('stocks')
      ? [{ topicPolicy: { topics: [{ name: 'Investing', action: 'BLOCKED', detected: true }] } }]
      : []),
  ];
  const mail = { ...call, userContent: `Write to ${EMAIL} please` };
  const stocks = { ...call, userContent: 'Which stocks should I buy?' };

  function guarded(
    behavior: Parameters<typeof createGuardrailClient>[1] = {},
    guard: Partial<Parameters<typeof harness>[0]> = {},
    answers: Parameters<typeof harness>[2] = {},
  ) {
    const guardrail = createGuardrailClient(assess, behavior);
    const aws = bedrockGuardrail({
      client: guardrail.client,
      guardrailIdentifier: 'gr-abc',
      guardrailVersion: '3',
      logger: 'silent',
    });
    const built = harness(
      {
        checks: [
          {
            id: 'pii',
            detect: aws.only('pii', 'regex'),
            action: 'redact',
            on: ['input', 'output'],
          },
          { id: 'topics', detect: aws.only('topic'), action: 'block', on: ['user', 'tool'] },
        ],
        ...guard,
      },
      {},
      answers,
    );
    return { ...built, guardrail };
  }

  it('redacts an email for the provider and puts it back in the answer', async () => {
    const { llm, primary } = guarded({}, {}, { primary: (params) => `Noted: ${tokenIn(params)}` });

    const answer = await llm.call(mail);

    expect(lastUserText(primary.calls[0]!)).not.toContain(EMAIL);
    expect(answer).toBe(`Noted: ${EMAIL}`);
  });

  it('blocks a denied topic before any provider is contacted', async () => {
    const { llm, primary, b, guardrail } = guarded();

    await expect(llm.call(stocks)).rejects.toMatchObject({ code: 'content_blocked' });

    expect(primary.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
    expect(guardrail.calls.map((request) => request.text)).toEqual([stocks.userContent]);
  });

  it('leaves a call with nothing found on the first target', async () => {
    const { llm, primary } = guarded();

    await expect(llm.call(call)).resolves.toBe('primary');

    expect(primary.calls).toHaveLength(1);
  });

  it('asks once for a text however many checks read it, and sends the answer as OUTPUT', async () => {
    const { llm, guardrail } = guarded();

    await llm.call(call);

    // Both checks read 'hi' and cost one request. The answer is read by the pii check only.
    expect(guardrail.calls.map(({ text, source }) => [text, source])).toEqual([
      ['hi', 'INPUT'],
      ['primary', 'OUTPUT'],
    ]);
  });

  it('does not ask again for the history of a conversation', async () => {
    const { llm, guardrail } = guarded();

    await llm.call({ ...call, userContent: 'hello' });
    await llm.call({
      ...call,
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'primary' },
      ],
      userContent: 'and then?',
    });

    // The history's user message is not asked again. Its assistant message is read as input now,
    // where the first turn read it as the model's output, so the guardrail sees it once more. The
    // second answer is the same text as the first, from the same source, and is not asked again.
    expect(guardrail.calls.map(({ text, source }) => `${source} ${text}`)).toEqual([
      'INPUT hello',
      'OUTPUT primary',
      'INPUT primary',
      'INPUT and then?',
    ]);
  });

  it('blocks rather than redact a topic, which has no position', async () => {
    const aws = bedrockGuardrail({
      client: createGuardrailClient(assess).client,
      guardrailIdentifier: 'gr-abc',
      guardrailVersion: '3',
      logger: 'silent',
    });
    const { llm, primary } = harness({
      checks: [{ id: 'topics', detect: aws.only('topic'), action: 'redact' }],
    });

    await expect(llm.call(stocks)).rejects.toMatchObject({ code: 'content_blocked' });
    expect(primary.calls).toHaveLength(0);
  });

  it('refuses the call when the guardrail is down, unless the check fails open', async () => {
    const down = new Error('guardrail down');
    const closed = guarded({ error: down });
    await expect(closed.llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
    expect(closed.primary.calls).toHaveLength(0);

    const open = guarded({ error: down }, { onError: 'open' });
    await expect(open.llm.call(call)).resolves.toBe('primary');
  });

  it('cancels the request when the check runs out of time, and then follows onError', async () => {
    const guardrail = createGuardrailClient(assess, { delayMs: 500 });
    const aws = bedrockGuardrail({
      client: guardrail.client,
      guardrailIdentifier: 'gr-abc',
      guardrailVersion: '3',
      logger: 'silent',
    });
    const { llm, primary } = harness({
      checks: [{ id: 'slow', detect: aws, action: 'block', timeoutMs: 30 }],
    });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });

    expect(primary.calls).toHaveLength(0);
    expect(guardrail.calls[0]!.signal!.aborted).toBe(true);
  });
});
