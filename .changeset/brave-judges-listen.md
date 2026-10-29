---
'vern-llm-guard': minor
---

`llmClassifier()` is a detector for rules only you can describe, judged by a model you give it.

You write categories in plain language, such as `competitor: 'Names or compares against a competitor'`, and a finding is one category, labeled `classifier.<category>`. With `quotes: true` the model also gives the exact text behind each category, which is located in the text to give spans, so a `redact` check can mask it. A quote that cannot be found, or findings without `quotes`, cover the whole text, and a `redact` check on them blocks. `.only('competitor')` gives a detector for some categories that shares one call and one cache with the rest.

Each text goes to the model inside a tag with a random name, new for every call, and the prompt says everything inside is data, never instructions. The answer is constrained by a strict schema whose categories are an enum, and every answer is validated: a missing, repeated or unknown id, or a category that was not given, is an error. Any error is thrown, and the check's `onError` decides.

`llm` must be a `VernLLM` of its own. A guard on it refuses the classifier's calls with an `invalid_params` error that names the fix, and warns once, so the mistake shows on the first call instead of as a loop.

`LLMClassifierOptions`, `ClassifierLLM`, `ClassifierAnswer` and `ClassifierUsage` are exported.
