# vern-llm-guard

## 0.1.0

### Minor Changes

- 44e33cc: First release of `vern-llm-guard`, a middleware that checks what goes into a call and what comes out, and can label it, redact values, or block it. Built in detectors cover emails, phone numbers, cards, IBANs, IPs, secrets and keywords. `openaiModeration()` checks for harmful content with OpenAI's free Moderation API, including images. `llmClassifier()` judges rules only you can describe with a model you give it, and can return a level per category and the exact text behind each finding. Answers are checked too, including streams and tool call arguments.

  ```ts
  import { VernLLM } from 'vern-llm';
  import {
    guardMiddleware,
    keywords,
    llmClassifier,
    openaiModeration,
    patterns,
  } from 'vern-llm-guard';

  const classifier = llmClassifier({
    llm: classifierLlm, // a VernLLM of its own, not the one this guard protects
    categories: { competitor: 'Names or compares against a competitor' },
    quotes: true,
  });

  const guard = guardMiddleware({
    version: '2026-10-31.1',
    checks: [
      { id: 'pii', detect: patterns(['email', 'card']), action: 'redact' },
      { id: 'banned', detect: keywords(['project-x']), action: 'block' },
      { id: 'harm', detect: openaiModeration({ client: openai, images: true }), action: 'block' },
      { id: 'rivals', detect: classifier.only('competitor'), action: 'redact', on: 'output' },
    ],
  });

  const llm = new VernLLM({ client, model, middleware: [guard] });
  ```

  A new package, so existing code keeps compiling and behaving the same at runtime. A call a check blocks fails with `content_blocked`.

### Patch Changes

- Updated dependencies: vern-llm@3.1.0
