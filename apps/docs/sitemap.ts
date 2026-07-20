import type { MetadataRoute } from 'next';

import { source } from '@/lib/source';

const baseUrl = 'https://vernllm.vercel.app';

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${baseUrl}/changelog`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.6,
    },
  ];

  const docRoutes: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${baseUrl}${page.url}`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: page.url === '/docs' ? 0.9 : 0.7,
  }));

  return [...staticRoutes, ...docRoutes];
}
