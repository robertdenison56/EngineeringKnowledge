import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'EKG — Engineering Knowledge',
  description: 'AEC engineering knowledge graph workspace',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="logo">
            EKG<span> · Engineering Knowledge</span>
          </Link>
          <nav>
            <Link href="/search">Browse &amp; search</Link>
            <Link href="/map">Map</Link>
            <Link href="/curation">Curate</Link>
            <Link href="/capture">Capture</Link>
          </nav>
          <div
            className="identity"
            title="Fixed development identity — production signs in with Entra ID SSO (PRD P0-9)"
          >
            demo-firm · user:dev
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          Answers are grounded with provenance. Engineering judgment and responsibility remain with
          the Engineer of Record.
        </footer>
      </body>
    </html>
  );
}
