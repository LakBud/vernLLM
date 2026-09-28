import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkLinks } from '../scripts/check-links';

const contentDir = path.join(import.meta.dirname, '..', 'content', 'docs');

let fixtureDir: string | undefined;

async function writeFixture(files: Record<string, string>): Promise<string> {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'docs-links-'));
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(fixtureDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  return fixtureDir;
}

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe('checkLinks', () => {
  // Parses every page in content/docs, which can outlast the default timeout.
  it('finds no broken internal links in content/docs', { timeout: 30_000 }, async () => {
    expect(await checkLinks(contentDir)).toEqual([]);
  });

  it('reports missing pages and missing anchors', async () => {
    const dir = await writeFixture({
      'index.mdx': '---\ntitle: Home\n---\n\n## Per-call overrides\n',
      'core/page.mdx': [
        '---',
        'title: Page',
        '---',
        '',
        '[root](/docs#per-call-overrides)',
        '[missing page](/docs/core/missing)',
        '[missing anchor](/docs#nope)',
        '[same page missing](#also-nope)',
        '<Card title="x" href="/docs/guides/missing" />',
      ].join('\n'),
    });

    const issues = await checkLinks(dir);

    expect(issues.map(({ link, line }) => ({ link, line }))).toEqual([
      { link: '/docs/core/missing', line: 6 },
      { link: '/docs#nope', line: 7 },
      { link: '#also-nope', line: 8 },
      { link: '/docs/guides/missing', line: 9 },
    ]);
  });

  it('resolves anchors the same way the site renders them', async () => {
    const dir = await writeFixture({
      'guides/index.mdx': '---\ntitle: Guides\n---\n\nIntro.\n',
      'notes.mdx': [
        '---',
        'title: Notes',
        '---',
        '',
        '## 2.0.0: Tool calling',
        "## Fields that don't inherit",
        '## `providerNames`',
        '## Repeated',
        '## Repeated',
        '## Custom heading [#custom-id]',
        '',
        '```md',
        '[inside a code block](/docs/not-checked)',
        '```',
      ].join('\n'),
      'links.mdx': [
        '---',
        'title: Links',
        '---',
        '',
        '[a](/docs/guides) [b](/docs/notes#200-tool-calling)',
        '[c](/docs/notes#fields-that-dont-inherit) [d](/docs/notes#providernames)',
        '[e](/docs/notes#repeated-1) [f](/docs/notes#custom-id)',
        '[external](https://example.com/docs/whatever)',
      ].join('\n'),
    });

    expect(await checkLinks(dir)).toEqual([]);
  });
});
