import { ApplyGuardrailCommand, type GuardrailAssessment } from '@aws-sdk/client-bedrock-runtime';

import type { GuardrailClient, GuardrailUsageInfo, Source } from './types.js';

type Content = ConstructorParameters<typeof ApplyGuardrailCommand>[0]['content'];

/** What a request answers: the assessments of every guardrail that read the content. */
export type Send = (
  side: 'INPUT' | 'OUTPUT',
  content: NonNullable<Content>,
  signal: AbortSignal,
) => Promise<GuardrailAssessment[]>;

export interface RequestConfig {
  name: string;
  client: GuardrailClient;
  guardrailIdentifier: string;
  guardrailVersion: string;
  report: (info: GuardrailUsageInfo) => void;
}

/** Bedrock reads the model's answer as `OUTPUT` and every other source as `INPUT`. */
export const sideOf = (source: Source): 'INPUT' | 'OUTPUT' =>
  source === 'output' ? 'OUTPUT' : 'INPUT';

/**
 * One `ApplyGuardrail` request. Assessments can't be attributed to content blocks, so a request
 * carries one text or one image, and the blocks that give a grounding check its context. A response
 * without assessments is an error: it must never quietly let content through.
 */
export function createRequest(config: RequestConfig): Send {
  const { name, client, guardrailIdentifier, guardrailVersion, report } = config;

  return async (source, content, signal) => {
    signal.throwIfAborted();
    const started = performance.now();
    const response = await client.send(
      new ApplyGuardrailCommand({ guardrailIdentifier, guardrailVersion, source, content }),
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
