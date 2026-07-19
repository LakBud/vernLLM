import { describe, it, expect, vi, afterEach } from 'vitest';

import { fromFetch } from '../../../src/adapters/fetch.js';

type FetchResponse = {
  text: string;
  usage?: {
    in: number;
    out: number;
  };
};

function isFetchResponse(json: unknown): json is FetchResponse {
  return typeof json === 'object' && json !== null && 'text' in json;
}

describe('fromFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the request via url/headers/mapRequest and parses the response via mapResponse', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello from provider' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com/generate',
      headers: { Authorization: 'Bearer key' },
      mapRequest: (params) => ({ model: params.model, prompt: params.messages[1].content }),
      mapResponse: (json: unknown) => {
        if (!isFetchResponse(json)) {
          throw new Error('Invalid response shape');
        }

        return { content: json.text };
      },
    });

    const result = await client.chat.completions.create(
      {
        model: 'example-model',
        temperature: 0.2,
        max_tokens: 10,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer key',
        }),
      }),
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody).toEqual({ model: 'example-model', prompt: 'u' });
    expect(result.choices?.[0]?.message?.content).toBe('hello from provider');
  });

  it('resolves a function url with the request params', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'x' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: (params) => `https://api.example.com/${params.model}`,
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => {
        if (!isFetchResponse(json)) {
          throw new Error('Invalid response shape');
        }

        return { content: json.text };
      },
    });

    await client.chat.completions.create(
      { model: 'my-model', temperature: 0.2, max_tokens: 10, messages: [] },
      { signal: new AbortController().signal },
    );

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/my-model', expect.anything());
  });

  it('resolves async header functions', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'x' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      headers: async () => ({ Authorization: 'Bearer async-token' }),
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => {
        if (!isFetchResponse(json)) {
          throw new Error('Invalid response shape');
        }

        return { content: json.text };
      },
    });

    await client.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [] },
      { signal: new AbortController().signal },
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer async-token');
  });

  it('maps usage fields when provided by mapResponse', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'x', usage: { in: 3, out: 4 } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => {
        if (!isFetchResponse(json) || !json.usage) {
          throw new Error('Invalid response shape');
        }

        return {
          content: json.text,
          usage: {
            promptTokens: json.usage.in,
            completionTokens: json.usage.out,
            totalTokens: json.usage.in + json.usage.out,
          },
        };
      },
    });

    const result = await client.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [] },
      { signal: new AbortController().signal },
    );

    expect(result.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
  });

  it('throws an error with .status set on a non-2xx response', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => {
        if (!isFetchResponse(json)) {
          throw new Error('Invalid response shape');
        }

        return { content: json.text };
      },
    });

    const err = await client.chat.completions
      .create(
        { model: 'm', temperature: 0.2, max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      )
      .catch((e) => e);

    expect(err.status).toBe(429);
    expect(err.message).toContain('rate limited');
  });

  it('passes the abort signal through to fetch', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'x' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = fromFetch({
      url: 'https://api.example.com',
      mapRequest: () => ({}),
      mapResponse: (json: unknown) => {
        if (!isFetchResponse(json)) {
          throw new Error('Invalid response shape');
        }

        return { content: json.text };
      },
    });

    const controller = new AbortController();
    await client.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [] },
      { signal: controller.signal },
    );

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });
});
