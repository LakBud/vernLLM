import { createElement } from 'react';

import { appName, gitConfig, npmUrl } from '@/lib/shared';
import { baseUrl } from '@/lib/utils';

export function JsonLd({ data }: { data: object }) {
  // Escape characters that could break out of the script tag or be
  // interpreted as HTML (e.g. a title/description containing the
  // closing tag sequence)
  const json = JSON.stringify(data)
    .replace(/[<]/g, '\\u003c')
    .replace(/[>]/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  // eslint-disable-next-line react/no-danger -- content is JSON-escaped above, not raw HTML
  return createElement('script', {
    type: 'application/ld+json',
    dangerouslySetInnerHTML: { __html: json },
  });
}

const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

const publisher = {
  '@type': 'Organization',
  name: appName,
  url: baseUrl,
  logo: { '@type': 'ImageObject', url: `${baseUrl}/logo.png` },
};

interface TechArticleInput {
  title: string;
  description?: string;
  url: string;
  image?: string;
  dateModified?: Date;
}

export function generateTechArticle({
  title,
  description,
  url,
  image,
  dateModified,
}: TechArticleInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description,
    url,
    mainEntityOfPage: url,
    inLanguage: 'en',
    image,
    dateModified: dateModified?.toISOString(),
    author: publisher,
    publisher,
  };
}

interface BreadcrumbItem {
  name: string;
  url: string;
}

export function generateBreadcrumbList(items: BreadcrumbItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

interface SoftwareApplicationInput {
  name: string;
  description: string;
  url: string;
}

export function generateSoftwareApplication({ name, description, url }: SoftwareApplicationInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name,
    description,
    url,
    programmingLanguage: 'TypeScript',
    codeRepository: githubUrl,
  };
}

interface WebSiteInput {
  name: string;
  description: string;
  url: string;
}

export function generateWebSite({ name, description, url }: WebSiteInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    description,
    url,
    inLanguage: 'en',
    publisher,
  };
}

export function generateOrganization() {
  return {
    '@context': 'https://schema.org',
    ...publisher,
    sameAs: [githubUrl, npmUrl],
  };
}

interface FaqItem {
  question: string;
  answer: string;
}

export function generateFaqPage(items: FaqItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
