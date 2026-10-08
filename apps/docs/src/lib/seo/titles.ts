export interface TitledPage {
  slugs: string[];
  title: string;
}

const sectionLabels: Record<string, string> = {
  core: 'Core',
  customization: 'Customization',
  guides: 'Guides',
  adapters: 'Adapters',
  'API-reference': 'API Reference',
};

const integrationLabels: Record<string, string> = {
  redis: 'Redis',
  otel: 'OpenTelemetry',
  bedrock: 'AWS Bedrock',
};

function sectionLabel(slugs: string[]): string | undefined {
  const [section, integration] = slugs;
  if (section === 'integrations') return integration ? integrationLabels[integration] : undefined;
  return section ? sectionLabels[section] : undefined;
}

/**
 * Maps each page (keyed by its slugs joined with "/") to a title that is unique across the site.
 * Titles that appear once are kept as is. Repeated ones, like "Caching" or "Changelog", get the
 * section appended, for example "Caching (Redis)". The visible page heading is not affected.
 */
export function buildSeoTitles(pages: TitledPage[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const page of pages) counts.set(page.title, (counts.get(page.title) ?? 0) + 1);

  const result = new Map<string, string>();
  for (const page of pages) {
    const label = sectionLabel(page.slugs);
    const repeated = (counts.get(page.title) ?? 0) > 1;
    result.set(page.slugs.join('/'), repeated && label ? `${page.title} (${label})` : page.title);
  }
  return result;
}
