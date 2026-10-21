import Image from 'next/image';
import { siX } from 'simple-icons';

import { appName, docsRoute, gitConfig } from './shared';

import type { BaseLayoutProps, LinkItemType } from 'fumadocs-ui/layouts/shared';

export const xLink: LinkItemType = {
  type: 'icon',
  url: 'https://x.com/VernLLM',
  text: 'X',
  label: 'VernLLM on X',
  external: true,
  icon: (
    <svg aria-hidden="true" viewBox="-1.5 -2.5 27 27" fill="currentColor">
      <path d={siX.path} />
    </svg>
  ),
};

/** A nav link into one docs section, lit while any page inside it is open. */
function docsLink(
  text: string,
  path: string,
  active: 'url' | 'nested-url' = 'nested-url',
): LinkItemType {
  return { text, url: `${docsRoute}${path}`, active };
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-2">
          <Image
            src="/logo.png"
            alt={appName}
            width={20}
            height={25}
            style={{ width: '20px', height: '25px' }}
          />
          <span>{appName}</span>
        </div>
      ),
    },
    links: [
      // Exact match: every docs page lives under /docs, so a nested match would keep this lit
      // while another section is open.
      docsLink('Get Started', '', 'url'),
      docsLink('Features', '/core'),
      docsLink('Adapters', '/adapters'),
      docsLink('Extensions', '/extensions'),
      docsLink('Integrations', '/integrations'),
      xLink,
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
