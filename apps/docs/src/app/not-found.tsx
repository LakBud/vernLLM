import { HomeLayout } from 'fumadocs-ui/layouts/home';
import Link from 'next/link';

import Squares from '@/components/squares';
import { baseOptions } from '@/lib/layout.shared';

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-fd-background px-6 text-center">
        <Squares squareSize={44} />

        <div className="relative z-10 flex flex-col items-center gap-4">
          <span className="font-mono text-sm text-fd-muted-foreground">404 Not Found</span>

          <h1 className="text-[15vw] font-bold leading-none tracking-tight text-fd-foreground lg:text-[8vw] pb-4">
            Nothing here.
          </h1>

          <p className="max-w-md text-base text-fd-muted-foreground">
            The page you're looking for doesn't exist, or it moved somewhere else.
          </p>

          <Link
            href="/docs"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-primary px-3 py-1.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Back to docs
          </Link>
        </div>
      </div>
    </HomeLayout>
  );
}
