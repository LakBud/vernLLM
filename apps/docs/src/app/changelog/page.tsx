import type { Metadata } from 'next';

import { compileMDX } from 'next-mdx-remote/rsc';
import fs from 'node:fs';
import path from 'node:path';

// The same release history lives at /docs/changelog, which is the page to rank.
export const metadata: Metadata = {
  title: 'Changelog',
  description: 'Release history for vern-llm, generated from Changesets.',
  alternates: { canonical: '/docs/changelog' },
};

export default async function ChangelogPage() {
  const changelogPath = path.join(process.cwd(), '../../packages/vern-llm/CHANGELOG.md');
  const content = fs.readFileSync(changelogPath, 'utf-8');

  const { content: rendered } = await compileMDX({ source: content });

  return (
    <div className="prose">
      <h1>Changelog</h1>
      {rendered}
    </div>
  );
}
