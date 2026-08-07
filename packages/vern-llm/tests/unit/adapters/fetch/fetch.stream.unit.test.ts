import { describe, it, expect, vi, afterEach } from 'vitest';

import { fromFetch } from '../../../../src/adapters/index.js';
import { at, fakeReadableStream } from '../../../helpers.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

interface DeltaEvent {
  delta?: string;
}

function isDeltaEvent(event: unknown): event is DeltaEvent {
  return typeof event === 'object' && event !== null;
}

describe('fromFetch().chat.completions.createStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws LLMError(validation) immediately when mapStreamEvent is not configured', async () => {
    const client = fromFetch({
      url: 'https://api.example.com',
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
    });

    await expect(
      collect(
        client.chat.completions.createStream!(
          { model: 'm', max_tokens: 10, messages: [] },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('opens the request via requestStream and translates each SSE event via mapStreamEvent (default SSE framing)', async () => {
    const requestStream = vi.fn(async (_url: string, _init: unknown) =>
      fakeReadableStream(['data: {"delta":"Hello, "}\n\n', 'data: {"delta":"world!"}\n\n']),
    );

    const client = fromFetch({
      url: 'https://api.example.com/stream',
      requestStream,
      mapRequest: (params) => ({ model: params.model }),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: (event) => {
        if (!isDeltaEvent(event) || !event.delta) return undefined;
        return { type: 'text-delta', delta: event.delta };
      },
    });

    const chunks = await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
    ]);
    expect(requestStream).toHaveBeenCalledWith(
      'https://api.example.com/stream',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('supports mapStreamEvent returning an array of WireStreamChunks for a single event', async () => {
    const requestStream = vi.fn(async () =>
      fakeReadableStream(['data: {"text":"hi","toolName":"get_weather"}\n\n']),
    );

    const client = fromFetch({
      url: 'https://api.example.com',
      requestStream,
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: (event) => {
        const e = event as { text?: string; toolName?: string };
        return [
          { type: 'text-delta', delta: e.text ?? '' },
          { type: 'tool_call_delta', index: 0, name: e.toolName },
        ];
      },
    });

    const chunks = await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'hi' },
      { type: 'tool_call_delta', index: 0, name: 'get_weather' },
    ]);
  });

  it('skips events for which mapStreamEvent returns undefined', async () => {
    const requestStream = vi.fn(async () =>
      fakeReadableStream(['data: {"ping":true}\n\n', 'data: {"delta":"hi"}\n\n']),
    );

    const client = fromFetch({
      url: 'https://api.example.com',
      requestStream,
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: (event) => {
        if (!isDeltaEvent(event) || !event.delta) return undefined;
        return { type: 'text-delta', delta: event.delta };
      },
    });

    const chunks = await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([{ type: 'text-delta', delta: 'hi' }]);
  });

  it('supports a custom parseStreamFrames for non-SSE framing (e.g. NDJSON)', async () => {
    // A source that yields raw NDJSON lines instead of SSE frames.
    const requestStream = vi.fn(async () =>
      fakeReadableStream(['{"delta":"a"}\n', '{"delta":"b"}\n']),
    );

    async function* parseNdjson(
      chunks: AsyncIterable<Uint8Array | string>,
    ): AsyncIterable<unknown> {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of chunks) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim()) yield JSON.parse(line);
          newlineIndex = buffer.indexOf('\n');
        }
      }
    }

    const client = fromFetch({
      url: 'https://api.example.com',
      requestStream,
      parseStreamFrames: parseNdjson,
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: (event) => {
        if (!isDeltaEvent(event) || !event.delta) return undefined;
        return { type: 'text-delta', delta: event.delta };
      },
    });

    const chunks = await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'a' },
      { type: 'text-delta', delta: 'b' },
    ]);
  });

  it('defaults requestStream to native fetch, using response.body', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      body: fakeReadableStream(['data: {"delta":"native"}\n\n']),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: (event) => {
        if (!isDeltaEvent(event) || !event.delta) return undefined;
        return { type: 'text-delta', delta: event.delta };
      },
    });

    const chunks = await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([{ type: 'text-delta', delta: 'native' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws an error with .status and .headers set when the default requestStream gets a non-2xx response', async () => {
    const responseHeaders = new Headers({ 'Retry-After': '30' });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: false,
      status: 429,
      headers: responseHeaders,
      text: async () => 'rate limited',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: () => undefined,
    });

    const err = await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).catch((e) => e);

    expect(err.status).toBe(429);
    expect(err.message).toContain('rate limited');
    expect(err.headers.get('Retry-After')).toBe('30');
  });

  it('omits body and Content-Type for GET requests, matching create()', async () => {
    const requestStream = vi.fn(async (_url: string, _init: unknown) => fakeReadableStream([]));

    const client = fromFetch({
      url: 'https://api.example.com',
      method: 'GET',
      requestStream,
      mapRequest: () => ({ ignored: true }),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: () => undefined,
    });

    await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    );

    const init = at(requestStream.mock.calls, 0)[1] as {
      body?: string;
      headers: Record<string, string>;
    };
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('passes the abort signal through to requestStream', async () => {
    const requestStream = vi.fn(async (_url: string, _init: unknown) => fakeReadableStream([]));

    const client = fromFetch({
      url: 'https://api.example.com',
      requestStream,
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: () => undefined,
    });

    const controller = new AbortController();
    await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: controller.signal },
      ),
    );

    expect(at(requestStream.mock.calls, 0)[1]).toMatchObject({ signal: controller.signal });
  });

  it('throws LLMError(validation) when a custom request transport is configured but requestStream is not, instead of silently falling back to native fetch', async () => {
    const customRequest = vi.fn(async (_url: string, _init: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      request: customRequest,
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: (event) => {
        if (!isDeltaEvent(event) || !event.delta) return undefined;
        return { type: 'text-delta', delta: event.delta };
      },
    });

    await expect(
      collect(
        client.chat.completions.createStream!(
          { model: 'm', max_tokens: 10, messages: [] },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ type: 'validation' });

    // Neither transport was actually invoked — the check fails fast,
    // before opening any connection.
    expect(customRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not require requestStream when no custom request transport is configured (native fetch is fine for both)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      body: fakeReadableStream(['data: {"delta":"ok"}\n\n']),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      // No `request`, no `requestStream` — both default to native fetch,
      // which is a consistent, non-surprising pairing.
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => ({ content: String(json) }),
      mapStreamEvent: (event) => {
        if (!isDeltaEvent(event) || !event.delta) return undefined;
        return { type: 'text-delta', delta: event.delta };
      },
    });

    const chunks = await collect(
      client.chat.completions.createStream!(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([{ type: 'text-delta', delta: 'ok' }]);
  });
});
