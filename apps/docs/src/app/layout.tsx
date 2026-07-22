import type { Metadata } from 'next';

import { Analytics } from '@vercel/analytics/next';

import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Inter } from 'next/font/google';

import { baseUrl } from '@/lib/utils';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: baseUrl,
  title: 'VernLLM',
  description: 'VernLLM documentation',
  icons: {
    icon: '/favicon.ico',
  },
  verification: {
    google: 'MlFiVXCMn-Rv2x1fE_x5q8TMWZu49CS6VWySgauTUfU',
  },
  openGraph: {
    title: 'VernLLM',
    description: 'VernLLM documentation',
    url: baseUrl,
    siteName: 'VernLLM',
    images: [
      {
        url: '/banner.png',
        width: 1200,
        height: 630,
        alt: 'VernLLM',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'VernLLM',
    description: 'VernLLM documentation',
    images: ['/banner.png'],
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
