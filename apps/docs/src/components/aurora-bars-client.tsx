'use client';

import type { ComponentProps } from 'react';

import dynamic from 'next/dynamic';

import { AuroraBars } from '@/components/unlumen-ui/aurora-bars';

export const AuroraBarsClient = dynamic(() => Promise.resolve(AuroraBars), {
  ssr: false,
}) as React.ComponentType<ComponentProps<typeof AuroraBars>>;
