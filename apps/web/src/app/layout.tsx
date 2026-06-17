import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'EKG — Engineering Knowledge',
  description: 'AEC engineering knowledge graph workspace',
};

/**
 * Applies the saved appearance (Settings → Appearance) before first paint, so
 * dark mode and density don't flash light on load. Reads the same localStorage
 * keys the AppearanceSettings client component writes.
 */
const THEME_INIT = `(function(){try{
  var t=localStorage.getItem('ekg-theme')||'system';
  var d=localStorage.getItem('ekg-density')||'comfortable';
  var sys=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  document.documentElement.setAttribute('data-theme', t==='system'?sys:t);
  document.documentElement.setAttribute('data-density', d);
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="site-header">
          <Link href="/" className="logo">
            EKG<span> · Engineering Knowledge</span>
          </Link>
          <nav>
            <Link href="/search">Browse &amp; search</Link>
            <Link href="/map">Map</Link>
            <Link href="/curation">Curate</Link>
            <Link href="/capture">Capture</Link>
            <Link href="/settings">Settings</Link>
          </nav>
          <div
            className="identity"
            title="Fixed development identity — production signs in with Entra ID SSO (PRD P0-9)"
          >
            demo-firm · user:dev
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          Answers are grounded with provenance. Engineering judgment and responsibility remain with
          the Engineer of Record.
        </footer>
      </body>
    </html>
  );
}
