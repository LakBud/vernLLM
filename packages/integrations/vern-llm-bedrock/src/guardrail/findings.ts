import { mergeSpans } from './hosted/chunks.js';
import { matchSpans } from './hosted/spans.js';

import type { Hit } from './hosted/types.js';
import type { GuardrailAssessment } from '@aws-sdk/client-bedrock-runtime';

interface Item {
  detected?: boolean | undefined;
  action?: string | undefined;
}

/**
 * Whether an item counts. A guardrail in detect mode reports `detected` with an action of `NONE`,
 * and a response without `detected` counts by its action.
 */
const counts = (item: Item): boolean => item.detected ?? item.action !== 'NONE';

/** Every place a returned match occurs. A match that is missing or not found gives no span. */
function located(text: string, label: string, match: string | undefined, wholeWord = false): Hit[] {
  return match ? matchSpans(text, label, [match], wholeWord) : [{ label }];
}

/** The findings of the items that count, each turned into hits by `toHits`. */
function each<T extends Item>(items: readonly T[] | undefined, toHits: (item: T) => Hit[]): Hit[] {
  return (items ?? []).filter(counts).flatMap((item) => toHits(item));
}

/** The findings of one assessment. Topics and content filters return no match, so they cover the text. */
function assessed(assessment: GuardrailAssessment, text: string): Hit[] {
  const { topicPolicy, contentPolicy, wordPolicy, sensitiveInformationPolicy } = assessment;

  return [
    ...each(sensitiveInformationPolicy?.piiEntities, ({ type, match }) =>
      located(text, `pii.${type ?? 'unknown'}`, match),
    ),
    ...each(sensitiveInformationPolicy?.regexes, ({ name, match }) =>
      located(text, `regex.${name ?? 'unnamed'}`, match),
    ),
    ...each(wordPolicy?.customWords, ({ match }) => located(text, 'word.custom', match, true)),
    ...each(wordPolicy?.managedWordLists, ({ type, match }) =>
      located(text, `word.${type ?? 'unknown'}`, match),
    ),
    ...each(topicPolicy?.topics, ({ name }) => [{ label: `topic.${name ?? 'unknown'}` }]),
    ...each(contentPolicy?.filters, ({ type }) => [{ label: `content.${type ?? 'unknown'}` }]),
  ];
}

/**
 * The findings of a response for one text. Bedrock's own action is not read: the check decides what
 * to do. An account or organization guardrail comes in the same list, and what two of them both
 * found is kept once.
 */
export function hitsOf(assessments: readonly GuardrailAssessment[], text: string): Hit[] {
  const hits = assessments.flatMap((assessment) => assessed(assessment, text));
  return mergeSpans([{ offset: 0, spans: hits }]);
}
