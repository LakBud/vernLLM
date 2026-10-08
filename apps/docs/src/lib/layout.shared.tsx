import Image from 'next/image';
import { siX } from 'simple-icons';

import { appName, gitConfig } from './shared';

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
      {
        text: 'Get Started',
        url: '/docs',
        active: 'nested-url',
      },
      {
        text: 'Features',
        url: '/docs/core',
        active: 'nested-url',
      },
      {
        text: 'Customization',
        url: '/docs/customization',
        active: 'nested-url',
      },
      {
        text: 'Adapters',
        url: '/docs/adapters',
        active: 'nested-url',
      },
      xLink,
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
