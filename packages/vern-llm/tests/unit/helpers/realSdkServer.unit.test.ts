import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../realSdkServer.js';

/** Minimal POST helper, since these tests talk to a real loopback server. */
function post(
  url: string,
  body: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * These exercise `tests/realSdkServer.ts` itself, the loopback HTTP server
 * that stands in for a provider's API in the real-SDK integration tests.
 * Every scripted-response path (`body`, `raw`, `hang`) is already proven
 * indirectly by those integration tests; this covers the two defensive
 * paths that only trigger on a genuine misuse or failure: no response
 * scripted at all, and a `raw` writer that itself throws.
 */
describe('startRealSdkServer', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('responds 500 with a clear error body when no response was scripted at all', async () => {
    server = await startRealSdkServer([]);

    const res = await post(`${server.url}/chat`, '{}');

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'realSdkServer: no response scripted' });
    // The request is still recorded even though nothing was scripted for it.
    expect(server.requests).toHaveLength(1);
  });

  it('responds 500 with a wrapped error when a raw response writer rejects before sending headers', async () => {
    server = await startRealSdkServer([
      {
        raw: async () => {
          throw new Error('raw writer boom');
        },
      },
    ]);

    const res = await post(`${server.url}/chat`, '{}');

    expect(res.status).toBe(500);
    const parsed = JSON.parse(res.body) as { error: string; message: string };
    expect(parsed.error).toBe('realSdkServer: raw response failed');
    expect(parsed.message).toBe('raw writer boom');
  });

  it('wraps a raw writer that rejects asynchronously the same way as one that rejects immediately', async () => {
    server = await startRealSdkServer([
      {
        raw: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error('async raw boom');
        },
      },
    ]);

    const res = await post(`${server.url}/chat`, '{}');

    expect(res.status).toBe(500);
    const parsed = JSON.parse(res.body) as { error: string; message: string };
    expect(parsed.message).toBe('async raw boom');
  });

  it('stringifies a non-Error rejection from a raw writer instead of losing the detail', async () => {
    server = await startRealSdkServer([
      {
        raw: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'not an Error instance';
        },
      },
    ]);

    const res = await post(`${server.url}/chat`, '{}');

    const parsed = JSON.parse(res.body) as { error: string; message: string };
    expect(parsed.message).toBe('not an Error instance');
  });

  it('ends the response with the wrapped error, without a second writeHead, when a raw writer rejects after already sending its own headers', async () => {
    server = await startRealSdkServer([
      {
        raw: async (res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: partial\n\n');
          throw new Error('failed mid-stream');
        },
      },
    ]);

    const res = await post(`${server.url}/chat`, '{}');

    // Headers were already sent by the raw writer as text/event-stream
    // (200), so the wrapper must not attempt a second writeHead; the
    // partial body plus the appended error JSON both land in the same
    // response.
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('data: partial');
    expect(res.body).toContain('failed mid-stream');
  });

  it('does nothing (no double-write on a destroyed socket) when a raw writer rejects after the client has already disconnected', async () => {
    server = await startRealSdkServer([
      {
        raw: async () => {
          // Gives the client time to abort before this rejects, so the
          // catch handler observes `res.destroyed: true`.
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('too late, client is gone');
        },
      },
    ]);

    const req = http.request(`${server.url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => {}); // destroying the socket surfaces as a client-side error too
    req.end('{}');

    await new Promise((resolve) => setTimeout(resolve, 10));
    req.destroy();

    // Give the server's raw() rejection time to fire against the now-
    // destroyed response; nothing should throw on the server side.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(server.requests).toHaveLength(1);
  });
});

describe('sseRaw', () => {
  it('writes one data: line per event, JSON-encoding non-string payloads', async () => {
    const server = await startRealSdkServer([
      { raw: sseRaw([{ data: { delta: 'hi' } }, { data: '[DONE]' }]) },
    ]);

    const res = await post(`${server.url}/chat`, '{}');
    await server.close();

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toBe('data: {"delta":"hi"}\n\ndata: [DONE]\n\n');
  });

  it('writes an event: line before data: when an event name is given', async () => {
    const server = await startRealSdkServer([
      { raw: sseRaw([{ event: 'message', data: { a: 1 } }]) },
    ]);

    const res = await post(`${server.url}/chat`, '{}');
    await server.close();

    expect(res.body).toBe('event: message\ndata: {"a":1}\n\n');
  });

  it('merges extra headers on top of the required content-type', async () => {
    const server = await startRealSdkServer([
      { raw: sseRaw([{ data: 'x' }], { 'x-ratelimit-remaining-requests': '5' }) },
    ]);

    const res = await post(`${server.url}/chat`, '{}');
    await server.close();

    expect(res.headers['x-ratelimit-remaining-requests']).toBe('5');
    expect(res.headers['content-type']).toBe('text/event-stream');
  });
});
