---
'vern-llm-bedrock': patch
---

`fromBedrock` leaves `temperature` out of `inferenceConfig` for Claude 4.7 and later, which reject it, so a default config call works. `temperatureUnsupportedModels` replaces that list with your own list or predicate.
