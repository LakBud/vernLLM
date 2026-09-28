import {
  ApplyGuardrailCommand,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it, vi } from 'vitest';

import { stubbedClient } from '../../helpers.js';

const converseInput = {
  modelId: 'm',
  messages: [{ role: 'user' as const, content: [{ text: 'hi' }] }],
};

describe('stubbedClient', () => {
  it('sends a ConverseCommand input and the abort signal to the converse handler', async () => {
    const converse = vi.fn(async () => ({ output: 'reply' }));
    const client = stubbedClient({ converse });
    const abortSignal = new AbortController().signal;

    const response = await client.send(new ConverseCommand(converseInput), { abortSignal });

    expect(response).toEqual({ output: 'reply' });
    expect(converse).toHaveBeenCalledExactlyOnceWith(converseInput, { signal: abortSignal });
  });

  it('sends a ConverseStreamCommand input and the abort signal to the stream handler', async () => {
    const stream = (async function* () {})();
    const converseStream = vi.fn(async () => ({ stream }));
    const client = stubbedClient({ converseStream });
    const abortSignal = new AbortController().signal;

    const response = await client.send(new ConverseStreamCommand(converseInput), { abortSignal });

    expect(response).toEqual({ stream });
    expect(converseStream).toHaveBeenCalledExactlyOnceWith(converseInput, { signal: abortSignal });
  });

  it('gives the handler an undefined signal when send is called without options', async () => {
    const converse = vi.fn(async () => ({}));
    const client = stubbedClient({ converse });

    await client.send(new ConverseCommand(converseInput));

    expect(converse).toHaveBeenCalledExactlyOnceWith(converseInput, { signal: undefined });
  });

  it('routes each command to its own handler when both are set', async () => {
    const converse = vi.fn(async () => 'converse');
    const converseStream = vi.fn(async () => ({}));
    const client = stubbedClient({ converse, converseStream });

    await client.send(new ConverseStreamCommand(converseInput));

    expect(converseStream).toHaveBeenCalledOnce();
    expect(converse).not.toHaveBeenCalled();
  });

  it('records each send on the client, so a test can inspect what was dispatched', async () => {
    const client = stubbedClient({ converse: async () => ({}) });
    const command = new ConverseCommand(converseInput);

    await client.send(command);

    expect(client.send).toHaveBeenCalledExactlyOnceWith(command);
  });

  it.each([
    {
      name: 'a ConverseCommand when only a stream handler is set',
      command: () => new ConverseCommand(converseInput),
      handlers: { converseStream: async () => ({}) },
    },
    {
      name: 'a ConverseStreamCommand when only a converse handler is set',
      command: () => new ConverseStreamCommand(converseInput),
      handlers: { converse: async () => ({}) },
    },
    {
      name: 'a command that is neither Converse nor ConverseStream',
      command: () => new ApplyGuardrailCommand({} as never),
      handlers: { converse: async () => ({}), converseStream: async () => ({}) },
    },
    {
      name: 'any command when no handler is set',
      command: () => new ConverseCommand(converseInput),
      handlers: {},
    },
  ])(
    'rejects $name, so a test never falls through to the network',
    async ({ command, handlers }) => {
      const client = stubbedClient(handlers);

      await expect(client.send(command() as never)).rejects.toThrow(
        /stubbedClient has no handler for/,
      );
    },
  );
});
