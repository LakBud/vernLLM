import { readFile, writeFile } from 'node:fs/promises';

const changelog = await readFile('packages/vern-llm/CHANGELOG.md', 'utf8');

const output = `---
title: Changelog
description: Release history for vern-llm
---

vern-llm uses Changesets for versioning. The release history below is generated automatically.

${changelog}
`;

await writeFile('apps/docs/content/docs/changelog.mdx', output);
