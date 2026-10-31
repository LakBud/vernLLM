# vern-llm-guard

## 0.1.0

### Minor Changes

- 5b677f0: `llmClassifier()` is a detector for rules only you can describe, judged by a model you give it.

  You write categories in plain language, such as `competitor: 'Names or compares against a competitor'`, and a finding is one category, labeled `classifier.<category>`. With `quotes: true` the model also gives the exact text behind each category, which is located in the text to give spans, so a `redact` check can mask it. A quote that cannot be found, or findings without `quotes`, cover the whole text, and a `redact` check on them blocks. `.only('competitor')` gives a detector for some categories that shares one call and one cache with the rest.

  Each text goes to the model inside a tag with a random name, new for every call, and the prompt says everything inside is data, never instructions. The answer is constrained by a strict schema whose categories are an enum, and every answer is validated: a missing, repeated or unknown id, or a category that was not given, is an error. Any error is thrown, and the check's `onError` decides.

  `llm` must be a `VernLLM` of its own. A guard on it refuses the classifier's calls with an `invalid_params` error that names the fix, and warns once, so the mistake shows on the first call instead of as a loop.

  `LLMClassifierOptions`, `ClassifierLLM`, `ClassifierAnswer` and `ClassifierUsage` are exported.

- 5f82328: Detectors can read images and the call. `images: true` gives a detector image segments, and `callView: true` gives it the request's text and the answer's meta for output checks. `openaiModeration` checks images when `images: true` is set (`unsupportedImages`), and `llmClassifier` takes `levels: true` with `only(..., { minLevel })`.
- 44e33cc: First release of `vern-llm-guard`, a middleware that checks what goes into a call and what comes out: label it, redact values, or block it.

  `guardMiddleware({ version, checks })` runs outside policy, usage and the router, so a blocked call reserves no budget and opens no connection. A check pairs a detector with an `action`: `label` (default) adds a label for policy, `redact` replaces each value with a keyed token the provider sees and restores it in the answer, and `block` refuses the call with `content_blocked`. `on` points a check at the request, a role, or the answer. `mode: 'audit'` reports what a check would do without doing it. A detector that throws or times out follows `onError`, which is `closed` by default.

  `patterns(['email', 'phone', 'card', 'iban', 'ip', 'secrets'])` and `keywords(list)` are built in, dependency free and validated (Luhn, mod 97), and a detector is a pure function so you can bring your own. Tokens are HMACs, nothing is stored, and an email token keeps the shape of an address on a domain that is never real. `redactFor` redacts per target, so a trusted primary can see the value while a fallback gets a token.

  Answers are checked too, plain, JSON mode and tool call arguments. A streamed answer is held, checked and released with `release: 'checked' | 'immediate'`, `holdChars` and `windowChars`, and `finalResult` checks the whole answer. `parallel` starts a slow blocking check with the call instead of before it. `spotlight` marks untrusted text so the model reads it as data.

  `guardLabels` feeds policy's `labels` option, and `guardLogFields` gives a log record `guard_outcome`, `guard_labels` and `guard_ms`. Every call emits one `guard.result` event with counts, kinds and timings, never content or offsets. `guard.evaluate()` returns the result a call would get from plain data, for measuring false positives before a check leaves audit. `guard.update()` validates new checks and swaps them atomically, and `guard.redactText` masks debug logs for the core's `redact` option.

- c7aeb1c: `openaiModeration()` is a detector for harmful content, backed by OpenAI's free Moderation API.

  A finding is one category, labeled `moderation.<category>`, over the whole text, so these checks label and block, and a `redact` check on them blocks. `.only('self-harm', 'violence')` gives a detector for some categories that shares one request and one cache with the rest, so several checks over one text cost one request. Texts are sent in batches, long texts are split in chunks, and `thresholds` count a category by its score instead of OpenAI's flag.

  Any error or malformed answer is thrown, and the check's `onError` decides. A `-latest` model warns once, because its results can change under the memo, so pin a dated one. The check's `timeoutMs` cancels the request, and a request that no call waits for any more is cancelled with it.

  The client is structural: anything with `moderations.create` fits, including the OpenAI SDK. `HostedDetector`, `HostedOptions`, `OpenAIModerationOptions`, `ModerationClient`, `ModerationResult`, `ModerationUsage` and `ModerationCategory` are exported.

### Patch Changes

- Updated dependencies: vern-llm@3.1.0
