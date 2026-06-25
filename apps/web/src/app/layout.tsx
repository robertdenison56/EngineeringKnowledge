import type { Metadata } from 'next';
import Link from 'next/link';
import { getFirmName } from '../lib/store';
import HeaderNav from '../components/HeaderNav';
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const firmName = await getFirmName();
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
          <Link href="/" className="logo" aria-label="Engineering Knowledge — home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ek-mark.png" alt="" className="logo-mark" width={34} height={34} />
            <span className="logo-word">
              <b>Engineering</b> <span>Knowledge</span>
            </span>
          </Link>
          <HeaderNav firmName={firmName} />
          <div
            className="identity"
            title="Firm name is set in Settings → Identity by an admin. The signed-in identity is fixed in development — production signs in with Entra ID SSO (PRD P0-9)."
          >
            {firmName} · user:dev
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
