---
'vern-llm': minor
---

`fromAnthropic` no longer sends `temperature`. `@anthropic-ai/sdk` 1.x sends API version `2026-10-21`, which removes it on every model and answers `temperature: Extra inputs are not permitted`, so a default config call failed. A client pinned to an older API version opts back in with `sendTemperature: true`; Claude 4.7 and later and calls with thinking on still never get it.

```ts
fromAnthropic(client, { sendTemperature: true });
```

Nothing changes for SDK 1.x clients, whose requests failed before. See [Migration Notes](/docs/migration-notes).
