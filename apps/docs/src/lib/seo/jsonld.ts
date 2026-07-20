import { createElement } from 'react';

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

interface TechArticleInput {
  title: string;
  description?: string;
  url: string;
}

export function generateTechArticle({ title, description, url }: TechArticleInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description,
    url,
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
    codeRepository: 'https://github.com/LakBud/vernLLM',
  };
}
