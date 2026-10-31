import { ApplyGuardrailCommand, type GuardrailAssessment } from '@aws-sdk/client-bedrock-runtime';

import type { GuardrailClient, GuardrailUsageInfo, Source } from './types.js';

/** What a request answers: the assessments of every guardrail that read the text. */
export type Ask = (
  text: string,
  source: Source,
  signal: AbortSignal,
) => Promise<GuardrailAssessment[]>;

export interface RequestConfig {
  name: string;
  client: GuardrailClient;
  guardrailIdentifier: string;
  guardrailVersion: string;
  report: (info: GuardrailUsageInfo) => void;
}

/**
 * One `ApplyGuardrail` request for one text. Assessments can't be attributed to content blocks, so
 * a request carries one block. A response without assessments is an error: it must never quietly
 * let text through.
 */
export function createRequest(config: RequestConfig): Ask {
  const { name, client, guardrailIdentifier, guardrailVersion, report } = config;

  return async (text, source, signal) => {
    signal.throwIfAborted();
    const started = performance.now();
    const response = await client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier,
        guardrailVersion,
        source: source === 'output' ? 'OUTPUT' : 'INPUT',
        content: [{ text: { text } }],
      }),
      { abortSignal: signal },
    );

    const assessments: unknown = response?.assessments;
    if (!Array.isArray(assessments)) {
      throw new Error(`${name}: the API answered without assessments`);
    }
    report({
      guardrailIdentifier,
      guardrailVersion,
      usage: response.usage,
      ms: Math.round(performance.now() - started),
    });
    return assessments as GuardrailAssessment[];
  };
}
