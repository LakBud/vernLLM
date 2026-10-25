---
'vern-llm-guard': minor
---

First release of `vern-llm-guard`, a middleware that checks what goes into a call and what comes out: label it, redact values, or block it.

`guardMiddleware({ version, checks })` runs outside policy, usage and the router, so a blocked call reserves no budget and opens no connection. A check pairs a detector with an `action`: `label` (default) adds a label for policy, `redact` replaces each value with a keyed token the provider sees and restores it in the answer, and `block` refuses the call with `content_blocked`. `on` points a check at the request, a role, or the answer. `mode: 'audit'` reports what a check would do without doing it. A detector that throws or times out follows `onError`, which is `closed` by default.

`patterns(['email', 'phone', 'card', 'iban', 'ip', 'secrets'])` and `keywords(list)` are built in, dependency free and validated (Luhn, mod 97), and a detector is a pure function so you can bring your own. Tokens are HMACs, nothing is stored, and an email token keeps the shape of an address on a domain that is never real. `redactFor` redacts per target, so a trusted primary can see the value while a fallback gets a token.

Answers are checked too, plain, JSON mode and tool call arguments. A streamed answer is held, checked and released with `release: 'checked' | 'immediate'`, `holdChars` and `windowChars`, and `finalResult` checks the whole answer. `parallel` starts a slow blocking check with the call instead of before it. `spotlight` marks untrusted text so the model reads it as data.

`guardLabels` feeds policy's `labels` option, and `guardLogFields` gives a log record `guard_outcome`, `guard_labels` and `guard_ms`. Every call emits one `guard.result` event with counts, kinds and timings, never content or offsets. `guard.evaluate()` returns the result a call would get from plain data, for measuring false positives before a check leaves audit. `guard.update()` validates new checks and swaps them atomically, and `guard.redactText` masks debug logs for the core's `redact` option.
