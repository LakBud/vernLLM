import http from 'node:http';

/**
 * A local, loopback-only HTTP server standing in for a provider's API, so
 * real-SDK integration tests can exercise an actual provider SDK instance
 * (real request serialization, real response parsing, real headers) without
 * network access or credentials. Each test scripts one response per
 * expected request; the raw request body/headers/url are recorded for
 * assertions on what the real SDK actually sent over the wire.
 */
export interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface RealSdkServer {
  /** `http://127.0.0.1:PORT`, suitable for an SDK client's `baseURL`/`endpoint` option. */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * One scripted response:
 *
 * - `{ status?, headers?, body }`: a single JSON response (the common,
 *   non-streaming case).
 *
 * - `{ status?, raw }`: full control over the response, for streaming wire
 *   formats (SSE, AWS's binary event-stream) that aren't a single JSON
 *   body. `raw` writes headers and body itself via the given
 *   `http.ServerResponse`.
 *
 * - `{ hang: true }`: accepts the request, records it, but never writes a
 *   response, leaving the connection open. For abort/cancellation tests:
 *   there's something for the client's `AbortSignal` to actually cancel.
 */
export type ScriptedResponse =
  | {
      status?: number;
      headers?: http.OutgoingHttpHeaders;
      body: unknown;
    }
  | { status?: number; raw: (res: http.ServerResponse) => void | Promise<void> }
  | { hang: true };

/**
 * Builds a `raw` response function that writes a Server-Sent-Events stream:
 * Anthropic, OpenAI, and Gemini's real streaming wire format (each just
 * differs in the JSON payload shape per event, not the SSE framing itself).
 */
export function sseRaw(
  events: Array<{ event?: string; data: unknown }>,
): (res: http.ServerResponse) => void {
  return (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) {
      if (e.event) res.write(`event: ${e.event}\n`);
      // String data (e.g. OpenAI's `[DONE]` sentinel) is written raw and
      // unquoted, matching the real wire format; anything else is
      // JSON-encoded, as every provider's actual event payloads are.
      const dataLine = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      res.write(`data: ${dataLine}\n\n`);
    }
    res.end();
  };
}

/**
 * Builds a `raw` response function that writes AWS's binary
 * `application/vnd.amazon.eventstream` format: Bedrock's real
 * `ConverseStream` wire format, structurally nothing like SSE.
 *
 * Note on `EventStreamMarshaller`'s constructor option names: they're
 * inverted from what `@smithy/util-utf8`'s own `fromUtf8`/`toUtf8` naming
 * suggests (confirmed empirically) - `utf8Encoder` must be `toUtf8` (bytes
 * -> string) and `utf8Decoder` must be `fromUtf8` (string -> bytes), the
 * reverse of what those names would suggest from `@smithy/util-utf8`
 * itself. Passing them the "obvious" way throws `RangeError: Offset is
 * outside the bounds of the DataView` deep inside header encoding.
 */
export async function bedrockEventStreamRaw(
  events: Array<{ eventType: string; payload: unknown }>,
): Promise<(res: http.ServerResponse) => Promise<void>> {
  const { EventStreamMarshaller } = await import('@smithy/eventstream-serde-node');
  const { fromUtf8, toUtf8 } = await import('@smithy/util-utf8');

  const marshaller = new EventStreamMarshaller({
    utf8Encoder: toUtf8,
    utf8Decoder: fromUtf8,
  });

  return async (res) => {
    res.writeHead(200, {
      'content-type': 'application/vnd.amazon.eventstream',
    });

    const encoded = marshaller.serialize(
      (async function* () {
        yield* events;
      })(),
      (event: { eventType: string; payload: unknown }) => ({
        headers: {
          ':event-type': {
            type: 'string' as const,
            value: event.eventType,
          },
          ':message-type': {
            type: 'string' as const,
            value: 'event',
          },
          ':content-type': {
            type: 'string' as const,
            value: 'application/json',
          },
        },
        body: new TextEncoder().encode(JSON.stringify(event.payload)),
      }),
    );

    for await (const chunk of encoded) {
      res.write(Buffer.from(chunk));
    }
    res.end();
  };
}

/**
 * Starts a mock server that replays `responses` in order, one per incoming
 * request, reusing the last entry for any requests beyond the scripted
 * count.
 */
export async function startRealSdkServer(responses: ScriptedResponse[]): Promise<RealSdkServer> {
  const requests: RecordedRequest[] = [];
  let callIndex = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    req.on('error', () => {
      // Client aborts/socket resets are expected during cancellation tests.
    });

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody: unknown = rawBody;

      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        // Non-JSON body (shouldn't happen for these SDKs); keep the raw string.
      }

      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody,
      });

      const entry = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;

      if (!entry) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'realSdkServer: no response scripted' }));
        return;
      }

      if ('hang' in entry) {
        // Intentionally never respond; the connection stays open until the
        // client aborts, times out, or the server is closed.
        return;
      }

      if ('raw' in entry) {
        void Promise.resolve(entry.raw(res)).catch((error: unknown) => {
          // The raw writer can fail because the client has already aborted.
          // In that case there is no response left to complete.
          if (res.destroyed) {
            return;
          }

          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
          }

          res.end(
            JSON.stringify({
              error: 'realSdkServer: raw response failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        });
        return;
      }

      res.writeHead(entry.status ?? 200, {
        'content-type': 'application/json',
        ...entry.headers,
      });
      res.end(JSON.stringify(entry.body));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('realSdkServer: failed to bind to a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
