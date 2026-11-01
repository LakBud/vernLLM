import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { fromAnthropic } from '../../../../src/adapters/claude/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { drain } from '../../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

import type { CallMeta } from '../../../../src/types/index.js';

describe('Anthropic provider refusals (real @anthropic-ai/sdk client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const message = (content: unknown[], stopReason: string) => ({
    id: 'msg_refusal',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 6 },
  });

  const refusalStream = (stopReason: string, text?: string) =>
    sseRaw([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      },
      ...(text
        ? [
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              },
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          ]
        : []),
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 6 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

  /** A primary that refuses, and a fallback that must not be called. */
  async function withFallback(response: Parameters<typeof startRealSdkServer>[0][number]) {
    server = await startRealSdkServer([response]);
    const fallbackServer = await startRealSdkServer([
      { body: message([{ type: 'text', text: 'from fallback' }], 'end_turn') },
    ]);

    const llm = new VernLLM({
      client: fromAnthropic(
        new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }),
      ),
      model: 'claude-test',
      maxRetries: 3,
      fallback: {
        client: fromAnthropic(
          new Anthropic({ apiKey: 'test-key', baseURL: fallbackServer.url, maxRetries: 0 }),
        ),
        model: 'claude-fallback',
      },
    });

    return { llm, fallbackServer };
  }

  it('fails once as model_refused when stop_reason is refusal with no content', async () => {
    const { llm, fallbackServer } = await withFallback({ body: message([], 'refusal') });

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
  });

  it('fails once as model_refused on a stream that ends in a refusal with no content', async () => {
    const { llm, fallbackServer } = await withFallback({ raw: refusalStream('refusal') });

    try {
      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
      });

      await expect(drain(chunks)).rejects.toMatchObject({ code: 'model_refused' });
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
    const { llm, fallbackServer } = await withFallback({ body: message([], 'refusal') });

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
    const { llm, fallbackServer } = await withFallback({ raw: refusalStream('refusal') });

    try {
      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonSchema: summarySchema,
        stream: true,
      });

      await expect(drain(chunks)).rejects.toMatchObject({ code: 'model_refused' });
      await expect(finalResult).rejects.toMatchObject({ code: 'model_refused' });
      expect(server?.requests).toHaveLength(1);
      expect(fallbackServer.requests).toHaveLength(0);
    } finally {
      await fallbackServer.close();
    }
  });

  it('still reports a missing forced tool when the stop reason is not a refusal', async () => {
    server = await startRealSdkServer([
      { body: message([{ type: 'text', text: 'no tool here' }], 'end_turn') },
    ]);
    const llm = new VernLLM({
      client: fromAnthropic(
        new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }),
      ),
      model: 'claude-test',
      maxRetries: 0,
    });

    await expect(llm.call({ userContent: 'hi', jsonSchema: summarySchema })).rejects.toMatchObject({
      type: 'validation',
    });
  });

  it('returns a partial answer that ends in a refusal', async () => {
    server = await startRealSdkServer([
      { body: message([{ type: 'text', text: 'Partial answer.' }], 'refusal') },
    ]);
    const llm = new VernLLM({
      client: fromAnthropic(
        new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }),
      ),
      model: 'claude-test',
    });

    const meta: { current?: CallMeta } = {};

    await expect(llm.call({ userContent: 'hi', jsonMode: false, meta })).resolves.toBe(
      'Partial answer.',
    );
    expect(meta.current?.finishReason).toBe('refusal');
  });

  it('returns streamed text that ends in a refusal', async () => {
    server = await startRealSdkServer([{ raw: refusalStream('refusal', 'Partial answer.') }]);
    const llm = new VernLLM({
      client: fromAnthropic(
        new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }),
      ),
      model: 'claude-test',
    });

    const meta: { current?: CallMeta } = {};

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      meta,
    });
    await drain(chunks);

    await expect(finalResult).resolves.toBe('Partial answer.');
    expect(meta.current?.finishReason).toBe('refusal');
  });

  it('leaves other stop reasons with no content as empty_response', async () => {
    server = await startRealSdkServer([{ body: message([], 'end_turn') }]);
    const llm = new VernLLM({
      client: fromAnthropic(
        new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }),
      ),
      model: 'claude-test',
      maxRetries: 0,
    });

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      code: 'empty_response',
    });
  });
});
