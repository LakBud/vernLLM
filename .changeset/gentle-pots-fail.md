---
'vern-llm': patch
---

Fix the published bundle shipping unminified: `tsdown.config.ts` was missing `minify: true`, so the package shipped full source with comments instead of a minified build (~206 kB / ~59 kB gzipped instead of the intended ~72 kB / ~21 kB gzipped).

While fixing this, also enabled `publint` and `unused` checks in the build and resolved what they found:

- Fixed `exports["."].types` to resolve correctly under both `import` and `require` conditions (previously CJS consumers using `require()` with TypeScript could get the wrong types).
- Added `"sideEffects": false` so bundlers can tree-shake the package.
- Fixed `repository.url` to a full git URL.
- Pinned `unplugin-unused` to `^0.4.4` to match the peer range `tsdown@0.9.9` actually requires.

No public API changes.
