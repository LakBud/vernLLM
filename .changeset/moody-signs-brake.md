---
'vern-llm-bedrock': minor
---

`bedrockGuardrail` can check images and judge grounding. `images: true` sends each PNG or JPEG image as its own request (`unsupportedImages`, `imageConcurrency`), and `aws.grounding()` judges an answer against the call's tool results with the guardrail's contextual grounding check.
