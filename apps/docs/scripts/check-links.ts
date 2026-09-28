// Verifies that every internal /docs/... link (and same page #anchor link) in
// content/docs resolves to a real page and, when an anchor is given, to a real
// heading id on that page. Heading ids come from Fumadocs' own remarkHeading
// plugin, so they match what the site renders.
//
// Usage: node scripts/check-links.ts [contentDir]

import { remarkHeading } from 'fumadocs-core/mdx-plugins/remark-heading';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { visit } from 'unist-util-visit';

const DOCS_ROUTE = '/docs';

export interface LinkIssue {
  file: string;
  line: number | undefined;
  link: string;
  reason: string;
}

interface ParsedPage {
  route: string;
  file: string;
  anchors: Set<string>;
  links: { url: string; line: number | undefined }[];
}

const processor = remark().use(remarkMdx).use(remarkGfm).use(remarkHeading, { generateToc: false });

async function listMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdx'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function routeFor(contentDir: string, file: string): string {
  const relative = path.relative(contentDir, file).split(path.sep).join('/');
  const withoutExt = relative.replace(/\.mdx$/, '');
  const slug = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '');
  return slug ? `${DOCS_ROUTE}/${slug}` : DOCS_ROUTE;
}

function stripFrontmatter(source: string): string {
  // Replace frontmatter with blank lines so reported line numbers stay accurate.
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, (block) => block.replace(/[^\n]/g, ''));
}

async function parsePage(contentDir: string, file: string): Promise<ParsedPage> {
  const source = stripFrontmatter(await readFile(file, 'utf8'));
  const tree = await processor.run(processor.parse(source));

  const anchors = new Set<string>();
  const links: ParsedPage['links'] = [];

  visit(tree, (node) => {
    if (node.type === 'heading') {
      const id = node.data?.hProperties?.id;
      if (typeof id === 'string') anchors.add(id);
      return;
    }

    if (node.type === 'link') {
      links.push({ url: node.url, line: node.position?.start.line });
      return;
    }

    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      for (const attribute of node.attributes) {
        if (attribute.type !== 'mdxJsxAttribute' || typeof attribute.value !== 'string') continue;
        if (attribute.name === 'href') {
          links.push({ url: attribute.value, line: node.position?.start.line });
        } else if (attribute.name === 'id') {
          anchors.add(attribute.value);
        }
      }
    }
  });

  return { route: routeFor(contentDir, file), file, anchors, links };
}

function splitInternalLink(
  url: string,
  currentRoute: string,
): { route: string; anchor: string } | null {
  if (url.startsWith('#')) return { route: currentRoute, anchor: decodeURIComponent(url.slice(1)) };
  if (
    url !== DOCS_ROUTE &&
    !url.startsWith(`${DOCS_ROUTE}/`) &&
    !url.startsWith(`${DOCS_ROUTE}#`)
  ) {
    return null;
  }

  const hashIndex = url.indexOf('#');
  const pathPart = (hashIndex === -1 ? url : url.slice(0, hashIndex)).split('?')[0] ?? '';
  const anchor = hashIndex === -1 ? '' : decodeURIComponent(url.slice(hashIndex + 1));
  const route = pathPart.length > DOCS_ROUTE.length ? pathPart.replace(/\/$/, '') : DOCS_ROUTE;
  return { route, anchor };
}

export async function checkLinks(contentDir: string): Promise<LinkIssue[]> {
  const files = await listMdxFiles(contentDir);
  const pages = await Promise.all(files.map((file) => parsePage(contentDir, file)));
  const byRoute = new Map(pages.map((page) => [page.route, page]));
  const issues: LinkIssue[] = [];

  for (const page of pages) {
    for (const { url, line } of page.links) {
      const target = splitInternalLink(url, page.route);
      if (!target) continue;

      const file = path.relative(contentDir, page.file).split(path.sep).join('/');
      const targetPage = byRoute.get(target.route);

      if (!targetPage) {
        issues.push({ file, line, link: url, reason: `no page at ${target.route}` });
      } else if (target.anchor && !targetPage.anchors.has(target.anchor)) {
        issues.push({
          file,
          line,
          link: url,
          reason: `no heading #${target.anchor} on ${target.route}`,
        });
      }
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const contentDir = path.resolve(
    process.argv[2] ?? path.join(import.meta.dirname, '..', 'content', 'docs'),
  );
  const issues = await checkLinks(contentDir);

  if (issues.length === 0) {
    console.log('All internal docs links resolve.');
    return;
  }

  for (const issue of issues) {
    console.error(`${issue.file}:${issue.line ?? '?'}  ${issue.link}  (${issue.reason})`);
  }
  console.error(`\n${issues.length} broken internal docs link(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
