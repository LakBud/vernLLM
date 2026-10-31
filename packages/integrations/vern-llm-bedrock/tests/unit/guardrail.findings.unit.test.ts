import { describe, expect, it } from 'vitest';

import { hitsOf } from '../../src/guardrail/findings.js';

import type { GuardrailAssessment } from '@aws-sdk/client-bedrock-runtime';

const text = 'Mail jane@acme.com or jane@acme.com. The word darn is here, not darning.';

const pii = (match: string | undefined, rest: object = {}) => ({
  sensitiveInformationPolicy: {
    piiEntities: [{ type: 'EMAIL', match, action: 'ANONYMIZED', ...rest }],
    regexes: [],
  },
});

describe('hitsOf', () => {
  describe('what each assessment item becomes', () => {
    it('labels pii by its type, with a span for every place of the match', () => {
      const first = text.indexOf('jane@acme.com');
      const second = text.lastIndexOf('jane@acme.com');

      expect(hitsOf([pii('jane@acme.com') as GuardrailAssessment], text)).toEqual([
        { label: 'pii.EMAIL', start: first, end: first + 13 },
        { label: 'pii.EMAIL', start: second, end: second + 13 },
      ]);
    });

    it('labels a regex by its name, and covers a match it cannot name', () => {
      const regexes = [
        { name: 'ticket', match: 'jane', action: 'BLOCKED' },
        { match: 'acme', action: 'BLOCKED' },
      ];

      const hits = hitsOf([{ sensitiveInformationPolicy: { regexes } } as never], text);

      expect(hits.map((hit) => hit.label)).toEqual([
        'regex.ticket',
        'regex.ticket',
        'regex.unnamed',
        'regex.unnamed',
      ]);
      expect(hits[0]).toMatchObject({ start: 5, end: 9 });
    });

    it('matches a custom word as a whole word only, and a managed word anywhere', () => {
      const wordPolicy = {
        customWords: [{ match: 'darn', action: 'BLOCKED' }],
        managedWordLists: [{ match: 'darn', type: 'PROFANITY', action: 'BLOCKED' }],
      };

      const whole = text.indexOf('darn');
      const inside = text.indexOf('darning');

      expect(hitsOf([{ wordPolicy } as never], text)).toEqual([
        { label: 'word.custom', start: whole, end: whole + 4 },
        { label: 'word.PROFANITY', start: whole, end: whole + 4 },
        { label: 'word.PROFANITY', start: inside, end: inside + 4 },
      ]);
    });

    it('covers the whole text for a topic and for a content filter, which return no match', () => {
      const assessment = {
        topicPolicy: { topics: [{ name: 'Investing', type: 'DENY', action: 'BLOCKED' }] },
        contentPolicy: {
          filters: [{ type: 'PROMPT_ATTACK', confidence: 'HIGH', action: 'BLOCKED' }],
        },
      };

      expect(hitsOf([assessment as never], text)).toEqual([
        { label: 'topic.Investing' },
        { label: 'content.PROMPT_ATTACK' },
      ]);
    });

    it('gives a finding without a span when its match is not in the text, or was not returned', () => {
      expect(hitsOf([pii('someone@else.org') as never], text)).toEqual([{ label: 'pii.EMAIL' }]);
      expect(hitsOf([pii(undefined) as never], text)).toEqual([{ label: 'pii.EMAIL' }]);
    });

    it('names a kind the SDK left out unknown, so nothing is dropped', () => {
      const assessment = {
        sensitiveInformationPolicy: { piiEntities: [{ match: 'jane', action: 'BLOCKED' }] },
        topicPolicy: { topics: [{ action: 'BLOCKED' }] },
        contentPolicy: { filters: [{ action: 'BLOCKED' }] },
        wordPolicy: { managedWordLists: [{ match: 'darn', action: 'BLOCKED' }] },
      };

      const labels = hitsOf([assessment as never], text).map((hit) => hit.label);

      expect(labels).toEqual(
        expect.arrayContaining(['pii.unknown', 'topic.unknown', 'content.unknown', 'word.unknown']),
      );
    });
  });

  describe('which items count', () => {
    const topic = (item: object): GuardrailAssessment =>
      ({ topicPolicy: { topics: [{ name: 'T', type: 'DENY', ...item }] } }) as never;

    it('counts what is detected, even when the guardrail only detects and does nothing', () => {
      expect(hitsOf([topic({ detected: true, action: 'NONE' })], text)).toHaveLength(1);
    });

    it('does not count an item that was not detected, whatever its action says', () => {
      expect(hitsOf([topic({ detected: false, action: 'BLOCKED' })], text)).toEqual([]);
    });

    it('reads the action when detected is absent: any but NONE counts', () => {
      expect(hitsOf([topic({ action: 'BLOCKED' })], text)).toHaveLength(1);
      expect(hitsOf([topic({ action: 'NONE' })], text)).toEqual([]);
    });

    it('ignores Bedrock’s own decision: an anonymized match is a finding like a blocked one', () => {
      const blocked = hitsOf([pii('jane', { action: 'BLOCKED' }) as never], text);
      const anonymized = hitsOf([pii('jane', { action: 'ANONYMIZED' }) as never], text);

      expect(blocked).toEqual(anonymized);
    });
  });

  describe('several assessments', () => {
    it('keeps what two guardrails both found once, as an account level one comes in the same list', () => {
      const mine = pii('jane@acme.com') as GuardrailAssessment;
      const account = {
        ...pii('jane@acme.com'),
        topicPolicy: { topics: [{ name: 'T', type: 'DENY', action: 'BLOCKED' }] },
      } as GuardrailAssessment;

      const hits = hitsOf([mine, account, account], text);

      expect(hits.filter((hit) => hit.label === 'pii.EMAIL')).toHaveLength(2);
      expect(hits.filter((hit) => hit.label === 'topic.T')).toHaveLength(1);
    });

    it('finds nothing in an empty list, or in policies with no items', () => {
      expect(hitsOf([], text)).toEqual([]);
      expect(
        hitsOf([{}, { topicPolicy: {}, wordPolicy: {}, contentPolicy: {} } as never], text),
      ).toEqual([]);
    });
  });
});
