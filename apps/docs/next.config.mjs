import { createMDX } from 'fumadocs-mdx/next';
import path from 'node:path';

/** @type {import('next').NextConfig} */

const root = path.resolve(process.cwd(), '../..');

const withMDX = createMDX();

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://vitals.vercel-insights.com https://va.vercel-scripts.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

const config = {
  reactStrictMode: true,
  poweredByHeader: false,

  turbopack: {
    root,
  },

  outputFileTracingRoot: root,

  async headers() {
    // Skip CSP in development: React's dev-mode debugging tools rely on eval(),
    // which the CSP blocks. React never uses eval() in production, so this only
    // affects local dev and doesn't weaken the deployed site.
    if (process.env.NODE_ENV !== 'production') {
      return [];
    }

    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default withMDX(config);
