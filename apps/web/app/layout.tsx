import type { Metadata, Viewport } from 'next';
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
  // Installed to the home screen (app/manifest.ts), it opens like an app, as duty officers need for
  // web push on iPhone (PROD §11.5).
  appleWebApp: { capable: true, title: 'SENTRY', statusBarStyle: 'black' },
};

export const viewport: Viewport = { themeColor: '#12161b', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable}`}>
      <body>{children}</body>
    </html>
  );
}
