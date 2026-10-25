import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const packages: Record<string, string> = {
  'vern-llm': 'apps/docs/content/docs/changelog.mdx',
  'vern-llm-redis': 'apps/docs/content/docs/integrations/redis/changelog.mdx',
  'vern-llm-otel': 'apps/docs/content/docs/integrations/otel/changelog.mdx',
  'vern-llm-bedrock': 'apps/docs/content/docs/integrations/bedrock/changelog.mdx',
  'vern-llm-logger': 'apps/docs/content/docs/extensions/logger/changelog.mdx',
  'vern-llm-usage': 'apps/docs/content/docs/extensions/usage/changelog.mdx',
  'vern-llm-router': 'apps/docs/content/docs/extensions/router/changelog.mdx',
  'vern-llm-policy': 'apps/docs/content/docs/extensions/policy/changelog.mdx',
};

// Package folders: core sits directly under packages/, integrations and extensions in their own folder.
const dirs: Record<string, string> = {
  'vern-llm-redis': 'packages/integrations',
  'vern-llm-otel': 'packages/integrations',
  'vern-llm-bedrock': 'packages/integrations',
  'vern-llm-logger': 'packages/extensions',
  'vern-llm-usage': 'packages/extensions',
  'vern-llm-router': 'packages/extensions',
  'vern-llm-policy': 'packages/extensions',
};

for (const [pkg, docPath] of Object.entries(packages)) {
  const changelogPath = `${dirs[pkg] ?? 'packages'}/${pkg}/CHANGELOG.md`;

  let changelog: string;
  try {
    changelog = await readFile(changelogPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No release yet for this package, nothing to write.
      continue;
    }
    throw error;
  }

  const output = `---
title: Changelog
description: Release history for ${pkg}
icon: Clock
---

${pkg} uses Changesets for versioning. The release history below is generated automatically.

${changelog}
`;

  // A new package's docs folder may not exist in the checkout yet.
  await mkdir(dirname(docPath), { recursive: true });
  await writeFile(docPath, output);
}
