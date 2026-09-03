import type { Metadata } from 'next';

import { Analytics } from '@vercel/analytics/next';

import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Inter } from 'next/font/google';

import CustomSearchDialog from '@/components/search-dialog';
import { baseUrl } from '@/lib/utils';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  metadataBase: baseUrl,
  title: 'VernLLM',
  description: 'The LLM call framework. Resilience, observability, and control for every call.',
  icons: {
    icon: '/favicon.ico',
  },
  verification: {
    google: [
      'MlFiVXCMn-Rv2x1fE_x5q8TMWZu49CS6VWySgauTUfU',
      'ouYzK7cF29I3UDhTZ9OeKs3df5i-jzpJg-N20c9fbfQ',
    ],
  },
  openGraph: {
    title: 'VernLLM',
    description: 'The LLM call framework. Resilience, observability, and control for every call.',
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
    <html lang="en" className={`${inter.className} ${inter.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ SearchDialog: CustomSearchDialog }}>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
