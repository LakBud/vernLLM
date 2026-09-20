import { createElement } from 'react';

import { icons } from 'lucide-react';
import { siOpentelemetry, siRedis } from 'simple-icons';

// Brand logos that aren't part of Lucide's generic icon set. Each entry is
// simple-icons path data for an official, actively-maintained brand mark,
// see https://simpleicons.org. Rendered in the theme's muted grey rather than
// the brand's own color, to match every other sidebar icon.
const brandIcons: Record<string, { path: string }> = {
  Redis: siRedis,
  OpenTelemetry: siOpentelemetry,
};

function BrandIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      className="text-fd-muted-foreground"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

// Passed as the `icon` option to loader() in source.ts. Resolves a brand name
// (e.g. "Redis") to its official simple-icons logo, and falls back to a plain
// Lucide icon lookup for everything else, the same behavior lucideIconsPlugin
// provided before this file replaced it.
export function resolveDocsIcon(icon?: string) {
  if (!icon) return undefined;

  const brand = brandIcons[icon];
  if (brand) return <BrandIcon path={brand.path} />;

  if (icon in icons) {
    return createElement(icons[icon as keyof typeof icons]);
  }

  return undefined;
}
