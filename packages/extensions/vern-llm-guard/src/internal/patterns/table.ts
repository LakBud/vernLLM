import { isIPv4, isIPv6 } from 'node:net';

import { ibanValid, luhnValid, phoneValid } from './validators.utils.js';

/** The kinds `patterns` knows how to find. */
export type PatternKind = 'email' | 'phone' | 'card' | 'iban' | 'ip' | 'secrets';

export interface Pattern {
  regex: RegExp;
  /** Cuts false positives: the match is kept only if this returns `true`. */
  valid?: (match: string) => boolean;
}

/**
 * Checked in this order, and a match overlapping an earlier kind's is dropped. A card number is
 * never also a phone number, and a key is never also anything else.
 */
export const ORDER: readonly PatternKind[] = ['secrets', 'email', 'iban', 'card', 'ip', 'phone'];

export const PATTERNS: Record<PatternKind, readonly Pattern[]> = {
  secrets: [
    {
      // The body is bounded, so text full of headers with no end costs a fixed amount for each.
      regex:
        /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[\s\S]{0,8192}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?/g,
    },
    {
      // Each part is read once and kept (the lookahead and its back reference), and is bounded,
      // so a long run of look alike text cannot make the scan quadratic.
      regex: /\b(?=(eyJ[\w-]{8,4096}))\1\.(?=(eyJ[\w-]{8,4096}))\2\.(?=([\w-]{8,4096}))\3/g,
    },
    { regex: /\bsk-(?:ant-|proj-)?[\w-]{20,}/g },
    { regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/g },
    { regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { regex: /\bAIza[\w-]{35}\b/g },
    { regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
    { regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
    { regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  ],
  email: [
    {
      // Starts only where a run of address characters starts, so a long run is read once.
      regex: /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    },
  ],
  iban: [
    {
      regex: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
      valid: ibanValid,
    },
  ],
  card: [{ regex: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, valid: luhnValid }],
  ip: [
    {
      regex: /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d]|\.\d)/g,
      valid: isIPv4,
    },
    {
      regex: /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g,
      // A bare `::` is the empty address, and far more often punctuation.
      valid: (match) => match.length > 2 && isIPv6(match),
    },
  ],
  phone: [
    {
      regex: /(?<![\w.+-])[+(]?\d[\d ().-]{6,18}\d(?!\w)/g,
      valid: phoneValid,
    },
  ],
};
