import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bedrockGuardrail } from '../../src/guardrail/index.js';
import { at } from '../helpers.js';
import { startRealSdkServer, type RealSdkServer } from '../realSdkServer.js';

const EMAIL = 'jane@acme.com';

const usage = {
  topicPolicyUnits: 1,
  contentPolicyUnits: 1,
  wordPolicyUnits: 0,
  sensitiveInformationPolicyUnits: 1,
  sensitiveInformationPolicyFreeUnits: 0,
  contextualGroundingPolicyUnits: 0,
};

const intervened = {
  usage,
  action: 'GUARDRAIL_INTERVENED',
  outputs: [{ text: 'Mail {EMAIL}' }],
  assessments: [
    {
      sensitiveInformationPolicy: {
        piiEntities: [{ type: 'EMAIL', match: EMAIL, action: 'ANONYMIZED', detected: true }],
      },
      topicPolicy: {
        topics: [{ name: 'Investing', type: 'DENY', action: 'BLOCKED', detected: true }],
      },
    },
  ],
};

describe('bedrockGuardrail with the real @aws-sdk/client-bedrock-runtime client', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function detector(
    maxAttempts = 1,
    options: Parameters<typeof bedrockGuardrail>[0] extends infer O ? Partial<O> : never = {},
  ) {
    if (!server) throw new Error('server not started');
    const client = new BedrockRuntimeClient({
      region: 'eu-west-1',
      endpoint: server.url,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: new NodeHttpHandler(),
      maxAttempts,
    });
    return bedrockGuardrail({
      client,
      guardrailIdentifier: 'gr-abc',
      guardrailVersion: '3',
      logger: 'silent',
      ...options,
    });
  }

  it('sends a real ApplyGuardrail request and reads the assessments into findings', async () => {
    server = await startRealSdkServer([{ body: intervened }]);
    const onUsage = vi.fn();
    const detect = detector(1, { onUsage });
    const text = `Mail ${EMAIL} about stocks`;

    const found = await detect([{ text, source: 'output' }], new AbortController().signal);

    const sent = at(server.requests, 0);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/guardrail/gr-abc/version/3/apply');
    expect(sent.body).toEqual({ source: 'OUTPUT', content: [{ text: { text } }] });

    expect(found).toEqual([
      { segment: 0, label: 'pii.EMAIL', start: 5, end: 5 + EMAIL.length },
      { segment: 0, label: 'topic.Investing' },
    ]);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guardrailIdentifier: 'gr-abc', usage }),
    );
  });

  it('finds nothing in a response where the guardrail did not step in', async () => {
    server = await startRealSdkServer([
      { body: { usage, action: 'NONE', outputs: [], assessments: [] } },
    ]);

    const found = await detector()(
      [{ text: 'hello', source: 'user' }],
      new AbortController().signal,
    );

    expect(found).toEqual([]);
  });

  it('lets the SDK retry a throttled request on its own, and answers from the retry', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        headers: { 'x-amzn-errortype': 'ThrottlingException' },
        body: { message: 'Too many requests' },
      },
      { body: intervened },
    ]);

    const found = await detector(3).only('pii')(
      [{ text: `Mail ${EMAIL}`, source: 'user' }],
      new AbortController().signal,
    );

    expect(server.requests).toHaveLength(2);
    expect(found).toHaveLength(1);
  });

  it('throws an access denied error as it is, so the caller’s onError decides', async () => {
    server = await startRealSdkServer([
      {
        status: 403,
        headers: { 'x-amzn-errortype': 'AccessDeniedException' },
        body: { message: 'not allowed to apply this guardrail' },
      },
    ]);

    await expect(
      detector()([{ text: 'hi', source: 'user' }], new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
  });

  it('stops waiting on a request mid flight when the call is aborted', async () => {
    server = await startRealSdkServer([{ hang: true }]);
    const controller = new AbortController();

    const pending = detector()([{ text: 'hi', source: 'user' }], controller.signal);
    await vi.waitFor(() => expect(server!.requests).toHaveLength(1));
    controller.abort(new Error('timed out'));

    // The call ends with its own reason, not the SDK's abort error.
    await expect(pending).rejects.toThrow('timed out');
  });
});
