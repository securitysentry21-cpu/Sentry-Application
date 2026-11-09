import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import './globals.css';

// design/README.md: Orbitron for short display labels, Inter for everything else. Both are files in
// app/fonts (SIL OFL 1.1, licences beside them), so building the dashboard fetches nothing from a
// third party (Fable pass 2, review L-35). Inter is Google Fonts' Latin subset, as next/font/google
// served it; Orbitron is the unmodified upstream file, since its licence reserves the name.
const display = localFont({
  src: './fonts/Orbitron-wght.ttf',
  weight: '400 900',
  variable: '--font-display',
});
const text = localFont({
  src: './fonts/inter-latin-variable.woff2',
  weight: '100 900',
  variable: '--font-text',
});

export const metadata: Metadata = {
  title: 'SENTRY Operations',
  description: 'Security guard operations dashboard',
  robots: { index: false, follow: false },
  // Installed to the home screen (app/manifest.ts), it opens like an app, as duty officers need for
  // web push on iPhone (PROD §11.5).
  appleWebApp: { capable: true, title: 'SENTRY', statusBarStyle: 'black' },
};

export const viewport: Viewport = { themeColor: '#12161b', colorScheme: 'dark' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request, so its scripts carry that response's CSP nonce (proxy.ts). A
  // page prerendered at build time has no nonce, and the policy would block its scripts.
  await connection();
  return (
    <html lang="en" className={`${display.variable} ${text.variable}`}>
      <body>{children}</body>
    </html>
  );
}
