import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildSeoTitles, type TitledPage } from '../src/lib/seo/titles';
import { siteDescription, siteTitle } from '../src/lib/shared';

const contentDir = path.join(import.meta.dirname, '..', 'content', 'docs');

interface PageMeta extends TitledPage {
  file: string;
  description: string;
}

async function loadPages(): Promise<PageMeta[]> {
  const files = (await readdir(contentDir, { recursive: true })).filter((f) => f.endsWith('.mdx'));

  return Promise.all(
    files.map(async (file) => {
      const source = await readFile(path.join(contentDir, file), 'utf-8');
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      const slugs = file
        .replace(/\.mdx$/, '')
        .split(path.sep)
        .filter((part, i, parts) => !(part === 'index' && i === parts.length - 1));

      return {
        file,
        slugs,
        title: frontmatter.match(/^title:\s*(.*)$/m)?.[1]?.trim() ?? '',
        description: frontmatter.match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? '',
      };
    }),
  );
}

describe('docs SEO', () => {
  it('gives every page a description of a useful search snippet length', async () => {
    const pages = await loadPages();
    const outOfRange = pages
      .filter(({ description }) => description.length < 70 || description.length > 160)
      .map(({ file, description }) => `${file} (${description.length})`);

    expect(outOfRange).toEqual([]);
  });

  it('uses a unique description on every page', async () => {
    const pages = await loadPages();
    const seen = new Set<string>();
    const duplicates = pages
      .filter(({ description }) => seen.size === seen.add(description).size)
      .map(({ file }) => file);

    expect(duplicates).toEqual([]);
  });

  it('resolves a unique title for every page', async () => {
    const pages = await loadPages();
    const titles = [...buildSeoTitles(pages).values()];

    expect(titles.filter((title, i) => titles.indexOf(title) !== i)).toEqual([]);
  });

  it('only adds a section to titles that repeat', () => {
    const titles = buildSeoTitles([
      { slugs: ['core', 'caching'], title: 'Caching' },
      { slugs: ['integrations', 'redis', 'features', 'cache'], title: 'Caching' },
      { slugs: ['changelog'], title: 'Changelog' },
      { slugs: ['integrations', 'otel', 'changelog'], title: 'Changelog' },
      { slugs: ['core', 'retries'], title: 'Retries' },
    ]);

    expect(Object.fromEntries(titles)).toEqual({
      'core/caching': 'Caching (Core)',
      'integrations/redis/features/cache': 'Caching (Redis)',
      changelog: 'Changelog',
      'integrations/otel/changelog': 'Changelog (OpenTelemetry)',
      'core/retries': 'Retries',
    });
  });

  it('keeps the site title and description within search result limits', () => {
    expect(siteTitle.length).toBeLessThanOrEqual(60);
    expect(siteDescription.length).toBeGreaterThanOrEqual(70);
    expect(siteDescription.length).toBeLessThanOrEqual(160);
  });
});
