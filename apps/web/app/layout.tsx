import type { Metadata } from 'next';
import { Inter, Orbitron } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

// design/README.md: Orbitron for short display labels, Inter for everything else.
const display = Orbitron({ subsets: ['latin'], weight: ['800'], variable: '--font-display' });
const text = Inter({ subsets: ['latin'], variable: '--font-text' });

export const metadata: Metadata = {
  title: 'SENTRY Operations',
  description: 'Security guard operations dashboard',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable}`}>
      <body>{children}</body>
    </html>
  );
}
