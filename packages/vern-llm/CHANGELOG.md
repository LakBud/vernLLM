# vern-llm

## 0.4.0

### Minor Changes

- 5e029b2: Add support for multi-turn conversation history via the `history` option in `CallParams`. Conversation history is now forwarded to all supported providers, including assistant messages, enabling native multi-turn interactions.

## 0.3.0

### Minor Changes

- 761d860: Make LLM throw LLMerror(timeout) when timeout aborts request

### Patch Changes

- afd54d9: Affirm directory on package

## 0.2.1

### Patch Changes

- ee5bb90: Connect repo with package

## 0.2.0

### Minor Changes

- dbce6e2: created a `tsconfig.base.json` which the `tsconfig.json` extends from
