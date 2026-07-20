'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/** Primary navigation. Mirrors the routes wired up under src/app. */
const LINKS = [
  { href: '/search', label: 'Browse & search' },
  { href: '/map', label: 'Map' },
  { href: '/ingest', label: 'Add documents' },
  { href: '/curation', label: 'Curate' },
  { href: '/capture', label: 'Capture' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/settings', label: 'Settings' },
];

/**
 * Header navigation. On wide screens the links sit on their own row beneath the
 * logo line (see globals.css); below the CSS breakpoint that inline row is
 * hidden and a hamburger opens a slide-in side drawer holding the same links.
 * The drawer stays mounted for the slide animation and is marked `inert` while
 * closed so its links stay out of the tab order and accessibility tree.
 */
export default function HeaderNav({ firmName }: { firmName: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  // While open: lock body scroll, close on Escape, and close if the window
  // grows past the breakpoint (where the inline nav row takes over).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const wide = window.matchMedia('(min-width: 701px)');
    const onWiden = () => {
      if (wide.matches) close();
    };
    document.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWiden);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWiden);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      {/* Inline links — own row below the logo; hidden below the breakpoint. */}
      <nav className="site-nav">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
      </nav>

      {/* Hamburger — shown below the breakpoint. */}
      <button
        type="button"
        className="nav-toggle"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="nav-drawer"
        onClick={() => setOpen(true)}
      >
        <span />
        <span />
        <span />
      </button>

      {/* Backdrop — only rendered while open. */}
      {open && <div className="nav-backdrop" onClick={close} aria-hidden="true" />}

      {/* Slide-in side drawer. */}
      <aside id="nav-drawer" className={`nav-drawer${open ? ' open' : ''}`} inert={!open}>
        <div className="nav-drawer-head">
          <span className="nav-drawer-title">Menu</span>
          <button type="button" className="nav-drawer-close" aria-label="Close menu" onClick={close}>
            ×
          </button>
        </div>
        <nav className="nav-drawer-links">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} onClick={close}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="nav-drawer-foot">{firmName} · user:dev</div>
      </aside>
    </>
  );
}
