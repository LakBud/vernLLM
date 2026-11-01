import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { VernLLM } from 'vern-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { collect } from '../helpers.js';
import { bedrockEventStreamRaw, startRealSdkServer, type RealSdkServer } from '../realSdkServer.js';

describe('Bedrock provider refusals (real @aws-sdk/client-bedrock-runtime client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const usage = { inputTokens: 12, outputTokens: 0, totalTokens: 12 };
  const reply = (stopReason: string, content: unknown[] = []) => ({
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage,
  });

  const refusalEvents = (stopReason: string, text?: string) => [
    { eventType: 'messageStart', payload: { role: 'assistant' } },
    ...(text
      ? [
          {
            eventType: 'contentBlockDelta',
            payload: { contentBlockIndex: 0, delta: { text } },
          },
          { eventType: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
        ]
      : []),
    { eventType: 'messageStop', payload: { stopReason } },
    { eventType: 'metadata', payload: { usage } },
  ];

  function clientFor(target: RealSdkServer): BedrockRuntimeClient {
    return new BedrockRuntimeClient({
      region: 'us-east-1',
      endpoint: target.url,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: new NodeHttpHandler(),
      maxAttempts: 1,
    });
  }

  /** A primary that refuses, and a fallback that must not be called. */
  async function withFallback(response: Parameters<typeof startRealSdkServer>[0][number]) {
    server = await startRealSdkServer([response]);
    const fallbackServer = await startRealSdkServer([
      { body: reply('end_turn', [{ text: 'from fallback' }]) },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(clientFor(server)),
      model: 'anthropic.claude-test',
      maxRetries: 3,
      baseDelayMs: 0,
      fallback: { client: fromBedrock(clientFor(fallbackServer)), model: 'anthropic.claude-fb' },
    });

    return { llm, fallbackServer };
  }

  async function single(response: Parameters<typeof startRealSdkServer>[0][number]) {
    server = await startRealSdkServer([response]);

    return new VernLLM({
      client: fromBedrock(clientFor(server)),
      model: 'anthropic.claude-test',
      maxRetries: 0,
    });
  }

  it.each([['guardrail_intervened'], ['content_filtered'], ['refusal']])(
    'fails once as model_refused on stopReason %s with no content',
    async (stopReason) => {
      const { llm, fallbackServer } = await withFallback({ body: reply(stopReason) });

      try {
        await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
          type: 'invalid_params',
          code: 'model_refused',
        });
        expect(server?.requests).toHaveLength(1);
        expect(fallbackServer.requests).toHaveLength(0);
      } finally {
        await fallbackServer.close();
      }
    },
  );

  it('fails once as model_refused on a stream that stops with a guardrail and no content', async () => {
    const { llm, fallbackServer } = await withFallback({
      raw: await bedrockEventStreamRaw(refusalEvents('guardrail_intervened')),
    });

    try {
      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
      });

      await expect(collect(chunks)).rejects.toMatchObject({ code: 'model_refused' });
      await expect(finalResult).rejects.toMatchObject({ code: 'model_refused' });
      expect(server?.requests).toHaveLength(1);
      expect(fallbackServer.requests).toHaveLength(0);
    } finally {
      await fallbackServer.close();
    }
  });

  const summarySchema = {
    name: 'Summary',
    schema: { type: 'object', properties: { headline: { type: 'string' } } },
  };

  it('fails as model_refused, not a missing tool, when a forced json_schema tool is refused', async () => {
    const { llm, fallbackServer } = await withFallback({ body: reply('refusal') });

    try {
      await expect(
        llm.call({ userContent: 'hi', jsonSchema: summarySchema }),
      ).rejects.toMatchObject({ type: 'invalid_params', code: 'model_refused' });
      expect(server?.requests).toHaveLength(1);
      expect(fallbackServer.requests).toHaveLength(0);
    } finally {
      await fallbackServer.close();
    }
  });

  it('fails a streamed forced json_schema tool as model_refused when it is refused', async () => {
    const { llm, fallbackServer } = await withFallback({
      raw: await bedrockEventStreamRaw(refusalEvents('guardrail_intervened')),
    });

    try {
      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonSchema: summarySchema,
        stream: true,
      });

      await expect(collect(chunks)).rejects.toMatchObject({ code: 'model_refused' });
      await expect(finalResult).rejects.toMatchObject({ code: 'model_refused' });
      expect(server?.requests).toHaveLength(1);
      expect(fallbackServer.requests).toHaveLength(0);
    } finally {
      await fallbackServer.close();
    }
  });

  it('still reports a missing forced tool when the stop reason is not a refusal', async () => {
    const llm = await single({ body: reply('end_turn', [{ text: 'no tool here' }]) });

    await expect(llm.call({ userContent: 'hi', jsonSchema: summarySchema })).rejects.toMatchObject({
      type: 'validation',
    });
  });

  it('returns the guardrail message when it arrives as content', async () => {
    const llm = await single({
      body: reply('guardrail_intervened', [{ text: 'Sorry, I cannot answer that.' }]),
    });

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).resolves.toBe(
      'Sorry, I cannot answer that.',
    );
  });

  it('returns a streamed guardrail message that arrives as content', async () => {
    const llm = await single({
      raw: await bedrockEventStreamRaw(
        refusalEvents('guardrail_intervened', 'Sorry, I cannot answer that.'),
      ),
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    await collect(chunks);

    await expect(finalResult).resolves.toBe('Sorry, I cannot answer that.');
  });

  it.each([['end_turn'], ['malformed_model_output'], ['max_tokens']])(
    'keeps failing as empty_response for stopReason %s with no content',
    async (stopReason) => {
      const llm = await single({ body: reply(stopReason) });

      await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
        code: 'empty_response',
      });
    },
  );
});
