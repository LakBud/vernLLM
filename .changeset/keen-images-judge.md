---
'vern-llm-guard': minor
---

Detectors can read images and the call. `images: true` gives a detector image segments, and `callView: true` gives it the request's text and the answer's meta for output checks. `openaiModeration` checks images when `images: true` is set (`unsupportedImages`), and `llmClassifier` takes `levels: true` with `only(..., { minLevel })`.
