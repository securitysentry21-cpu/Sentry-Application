'use client';

import type { ReactNode } from 'react';

import { AppShell } from '../../components/shell';
import { LiveProvider } from '../../lib/live';
import { SessionProvider } from '../../lib/session';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <LiveProvider>
        <AppShell>{children}</AppShell>
      </LiveProvider>
    </SessionProvider>
  );
}
