'use client';

import type { ReactNode } from 'react';

import { AlarmProvider } from '../../components/alarm';
import { AppShell } from '../../components/shell';
import { LiveProvider } from '../../lib/live';
import { SessionProvider } from '../../lib/session';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <LiveProvider>
        <AlarmProvider>
          <AppShell>{children}</AppShell>
        </AlarmProvider>
      </LiveProvider>
    </SessionProvider>
  );
}
