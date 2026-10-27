---
'vern-llm-guard': minor
---

`openaiModeration()` is a detector for harmful content, backed by OpenAI's free Moderation API.

A finding is one category, labeled `moderation.<category>`, over the whole text, so these checks label and block, and a `redact` check on them blocks. `.only('self-harm', 'violence')` gives a detector for some categories that shares one request and one cache with the rest, so several checks over one text cost one request. Texts are sent in batches, long texts are split in chunks, and `thresholds` count a category by its score instead of OpenAI's flag.

Any error or malformed answer is thrown, and the check's `onError` decides. A `-latest` model warns once, because its results can change under the memo, so pin a dated one. The check's `timeoutMs` cancels the request, and a request that no call waits for any more is cancelled with it.

The client is structural: anything with `moderations.create` fits, including the OpenAI SDK. `HostedDetector`, `HostedOptions`, `OpenAIModerationOptions`, `ModerationClient`, `ModerationResult`, `ModerationUsage` and `ModerationCategory` are exported.
