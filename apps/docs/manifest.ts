import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'VernLLM Documentation',
    short_name: 'VernLLM',
    description:
      'A lightweight resilience layer for OpenAI-compatible chat completion calls; retries, timeouts, circuit breaking, caching, structured output, and usage tracking, with one interface across providers.',
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
