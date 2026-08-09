import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromAnthropic } from '../../../../src/adapters/anthropic.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at, drain } from '../../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

// `fromAnthropic` accepts a real `Anthropic` client instance directly, no
// wrapper or cast needed: `AnthropicClient`'s TS types now match the real
// SDK's own generated types closely enough (narrowed `media_type`, a
// proper discriminated `tool_choice` union, and `input_schema: { type:
// 'object' }`) that `fromAnthropic(anthropic)` just type-checks.

/**
 * Exercises `fromAnthropic` against a *real* `@anthropic-ai/sdk` client
 * instance, pointed at a local mock server instead of `api.anthropic.com`.
 * Unlike `anthropic.int.test.ts` (which hand-rolls a fake `{ messages: {
 * create } }` object), this proves the adapter's structural `AnthropicClient`
 * type actually matches what the real SDK sends/returns on the wire, that
 * `messages.create` really is callable the way the adapter calls it, and
 * that the SDK's real response objects parse the way the adapter expects.
 */
describe('Anthropic adapter integration (real @anthropic-ai/sdk client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('drives a real Anthropic SDK client through VernLLM.call end to end', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Paris is the capital of France.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 24, output_tokens: 9 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const result = await llm.call({
      systemPrompt: 'You are a helpful geography assistant.',
      userContent: "What's the capital of France?",
      jsonMode: false,
    });

    expect(result).toBe('Paris is the capital of France.');

    const sent = at(server.requests, 0);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('test-key');
    expect(sent.body).toMatchObject({
      model: 'claude-test',
      system: 'You are a helpful geography assistant.',
      messages: [{ role: 'user', content: "What's the capital of France?" }],
    });
  });

  it('forces real tool-use for json_schema structured output and unwraps the real SDK response', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_02',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'Summary',
              input: { headline: 'Real SDK works', score: 9 },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 30, output_tokens: 12 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });
    const client = fromAnthropic(anthropic);

    const result = await client.chat.completions.create(
      {
        model: 'claude-test',
        temperature: 0.2,
        max_tokens: 200,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Summary',
            schema: {
              type: 'object',
              properties: { headline: { type: 'string' }, score: { type: 'number' } },
              required: ['headline', 'score'],
            },
          },
        },
        messages: [{ role: 'user', content: 'Summarize the test results.' }],
      },
      { signal: new AbortController().signal },
    );

    expect(JSON.parse(result.choices?.[0]?.message?.content ?? '')).toEqual({
      headline: 'Real SDK works',
      score: 9,
    });
    expect(result.usage).toEqual({ prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 });

    const sent = at(server.requests, 0);
    expect(sent.body).toMatchObject({
      tools: [expect.objectContaining({ name: 'Summary' })],
      tool_choice: { type: 'tool', name: 'Summary' },
    });
  });

  it('surfaces a real Anthropic SDK error (429) through VernLLM retry handling', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        body: {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Rate limited by mock server' },
        },
      },
      {
        body: {
          id: 'msg_03',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'ok after retry' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
      maxRetries: 1,
      baseDelayMs: 1,
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('ok after retry');
    expect(server.requests.length).toBe(2);
  });

  it('passes real multimodal image content through to the Anthropic SDK', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_04',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'I see a small red square.' }],
          usage: { input_tokens: 40, output_tokens: 8 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const result = await llm.call({
      userContent: [
        { type: 'text', text: "What's in this image?" },
        { type: 'image', data: 'ZmFrZWJhc2U2NA==', mimeType: 'image/png' },
      ],
      jsonMode: false,
    });

    expect(result).toBe('I see a small red square.');

    const sent = at(server.requests, 0);
    expect(sent.body).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZWJhc2U2NA==' },
            },
          ],
        },
      ],
    });
  });

  it('streams live text-delta chunks from a real Anthropic SSE response and resolves finalResult', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          {
            event: 'message_start',
            data: { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          },
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
              delta: { type: 'text_delta', text: 'Hello, ' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'world!' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
      },
    ]);

    await expect(finalResult).resolves.toBe('Hello, world!');
  });

  it('honors an aborted signal against a real Anthropic SDK client mid-request', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const anthropic = new Anthropic({
      apiKey: 'test-key',
      baseURL: server.url,
      maxRetries: 0,
    });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
      maxRetries: 0,
    });

    const controller = new AbortController();
    const callPromise = llm.call({
      userContent: 'hi',
      jsonMode: false,
      signal: controller.signal,
    });

    // Wait until the mock server has recorded the request so the abort
    // happens while the real SDK request is genuinely in flight.
    await vi.waitUntil(() => (server?.requests.length ?? 0) > 0);
    controller.abort();

    await expect(callPromise).rejects.toMatchObject({
      name: 'LLMError',
      type: 'aborted',
    });
  });
});
