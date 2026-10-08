import type { Metadata } from 'next';

import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { notFound } from 'next/navigation';
import path from 'node:path';

import { getMDXComponents } from '@/components/mdx';
import { generateBreadcrumbList, generateTechArticle, JsonLd } from '@/lib/seo/jsonld';
import { getLastModified } from '@/lib/seo/last-modified';
import { buildSeoTitles } from '@/lib/seo/titles';
import { gitConfig } from '@/lib/shared';
import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';
import { baseUrl } from '@/lib/utils';

const seoTitles = buildSeoTitles(
  source.getPages().map((page) => ({ slugs: page.slugs, title: page.data.title })),
);

function getSeoTitle(page: { slugs: string[]; data: { title: string } }) {
  return seoTitles.get(page.slugs.join('/')) ?? page.data.title;
}

function getDateModified(page: { path: string }) {
  return getLastModified(path.join(process.cwd(), 'content', 'docs', page.path));
}

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;

  const breadcrumbItems = [
    { name: 'Docs', url: `${baseUrl}/docs` },
    ...page.slugs.map((slug, i) => {
      const trail = page.slugs.slice(0, i + 1);
      return {
        name: source.getPage(trail)?.data.title ?? slug,
        url: `${baseUrl}/docs/${trail.join('/')}`,
      };
    }),
  ];

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <JsonLd
        data={generateTechArticle({
          title: getSeoTitle(page),
          description: page.data.description,
          url: `${baseUrl}${page.url}`,
          image: `${baseUrl}${getPageImage(page).url}`,
          dateModified: getDateModified(page),
        })}
      />
      <JsonLd data={generateBreadcrumbList(breadcrumbItems)} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/docs/content/docs/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const image = getPageImage(page).url;
  const title = getSeoTitle(page);
  const modifiedTime = getDateModified(page)?.toISOString();

  return {
    title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
    },
    openGraph: {
      title,
      description: page.data.description,
      type: 'article',
      url: page.url,
      images: image,
      modifiedTime,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: page.data.description,
      images: image,
    },
  };
}
