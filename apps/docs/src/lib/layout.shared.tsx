import Image from 'next/image';

import { appName, gitConfig } from './shared';

import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

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
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
