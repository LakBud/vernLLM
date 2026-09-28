import { createElement } from 'react';

import { icons } from 'lucide-react';

import { brandIcons, type BrandIconData } from './brand-icons';

// Rendered in the theme's muted grey rather than the brand's own color, to
// match every other sidebar icon.
function BrandIcon({ path, fillRule }: BrandIconData) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      className="text-fd-muted-foreground"
      aria-hidden="true"
    >
      <path d={path} fillRule={fillRule} />
    </svg>
  );
}

// Passed as the `icon` option to loader() in source.ts. Resolves a brand name
// (e.g. "Redis") to its logo, and falls back to a plain Lucide icon lookup for
// everything else, the same behavior lucideIconsPlugin provided before this
// file replaced it.
export function resolveDocsIcon(icon?: string) {
  if (!icon) return undefined;

  const brand = brandIcons[icon];
  if (brand) return <BrandIcon {...brand} />;

  if (icon in icons) {
    return createElement(icons[icon as keyof typeof icons]);
  }

  return undefined;
}
