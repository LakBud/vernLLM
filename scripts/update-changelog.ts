import { readFile, writeFile } from 'node:fs/promises';

const packages: Record<string, string> = {
  'vern-llm': 'apps/docs/content/docs/changelog.mdx',
  'vern-llm-redis': 'apps/docs/content/docs/integrations/redis/changelog.mdx',
};

for (const [pkg, docPath] of Object.entries(packages)) {
  const changelogPath = `packages/${pkg}/CHANGELOG.md`;

  let changelog: string;
  try {
    changelog = await readFile(changelogPath, 'utf8');
  } catch {
    // No release yet for this package, nothing to write.
    continue;
  }

  const output = `---
title: Changelog
description: Release history for ${pkg}
icon: Clock
---

${pkg} uses Changesets for versioning. The release history below is generated automatically.

${changelog}
`;

  await writeFile(docPath, output);
}
