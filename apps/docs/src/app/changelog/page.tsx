import { compileMDX } from 'next-mdx-remote/rsc';
import fs from 'node:fs';
import path from 'node:path';

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
