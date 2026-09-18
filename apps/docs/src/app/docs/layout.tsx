import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Blocks } from 'lucide-react';
import Image from 'next/image';

import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      {...baseOptions()}
      links={[]}
      tree={source.pageTree}
      sidebar={{
        tabs: [
          {
            title: 'VernLLM',
            description: 'The LLM call framework',
            icon: <Image src="/logo.png" alt="VernLLM" width={16} height={20} />,
            url: '/docs',
          },
          {
            title: 'Integrations',
            description: 'Take your LLM calls further',
            icon: <Blocks className="size-4 text-fd-primary" />,
            url: '/docs/integrations',
          },
        ],
      }}
    >
      {children}
    </DocsLayout>
  );
}
