'use client';

import { useEffect, useState } from 'react';

import { AuroraBars } from '@/components/unlumen-ui/aurora-bars';

export function AuroraBarsClient(props: React.ComponentProps<typeof AuroraBars>) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className={props.className} />;
  }

  return <AuroraBars {...props} />;
}
