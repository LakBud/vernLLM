import type { MetadataRoute } from 'next';

import { siteDescription } from '@/lib/shared';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'VernLLM Documentation',
    short_name: 'VernLLM',
    description: siteDescription,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#000000',
    icons: [
      {
        src: '/favicon.ico',
        sizes: 'any',
        type: 'image/x-icon',
      },
      {
        src: '/logo.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
    id: '/',
  };
}
