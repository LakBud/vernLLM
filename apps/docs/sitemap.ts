import type { MetadataRoute } from 'next';

import path from 'node:path';

import { getLastModified } from '@/lib/seo/last-modified';
import { source } from '@/lib/source';
import { baseUrl } from '@/lib/utils';

// /changelog repeats /docs/changelog and canonicalizes to it, so only the docs copy is listed.
export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];

  const docRoutes: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${baseUrl}${page.url}`,
    lastModified: getLastModified(path.join(process.cwd(), 'content', 'docs', page.path)),
    changeFrequency: 'weekly',
    priority: page.url === '/docs' ? 0.9 : 0.7,
  }));

  return [...staticRoutes, ...docRoutes];
}
