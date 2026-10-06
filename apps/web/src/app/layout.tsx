import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'BananaGig', template: '%s · BananaGig' },
  description: 'Local help. Done fast.',
  applicationName: 'BananaGig',
  manifest: '/manifest.webmanifest',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f5c518' };

/**
 * Root shell. Persona shells (customer / provider / admin) will be nested route-group layouts that wrap
 * `children`; none exist yet, so this layout stays persona-neutral.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <span className="brand">BananaGig</span>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
