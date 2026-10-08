import type { Metadata } from 'next';

import { Analytics } from '@vercel/analytics/next';

import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Inter } from 'next/font/google';

import CustomSearchDialog from '@/components/search-dialog';
import { appName, siteDescription, siteTitle } from '@/lib/shared';
import { baseUrl } from '@/lib/utils';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  metadataBase: baseUrl,
  title: {
    default: 'VernLLM',
    template: `%s | ${appName}`,
  },
  description: siteDescription,
  applicationName: appName,
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
    title: siteTitle,
    description: siteDescription,
    url: baseUrl,
    siteName: appName,
    images: [
      {
        url: '/banner.png',
        width: 1200,
        height: 630,
        alt: siteTitle,
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: siteDescription,
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
