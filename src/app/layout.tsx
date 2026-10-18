import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { THEME_BOOTSTRAP } from '@/components/theme-toggle';

import './globals.css';

export const metadata: Metadata = {
  title: 'Relay — Web API client',
  description:
    'Send HTTP requests from the browser through a proxy that refuses private network addresses.',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Relay',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#080b12' },
    { media: '(prefers-color-scheme: light)', color: '#f7f5ff' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning because the bootstrap script sets data-theme
    // before React hydrates, so the server markup and the DOM differ by design.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
