'use client';

import { useEffect, useState } from 'react';

/**
 * Appearance controls for the Settings page. Preferences live in
 * localStorage (this is a single-user dev app with no per-user persistence
 * layer yet); the layout's no-flash script reads the same keys on load so
 * the choice survives navigation and reload without a backend.
 */

type Theme = 'system' | 'light' | 'dark';
type Density = 'comfortable' | 'compact';

const THEME_OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Match the OS setting' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
];
const DENSITY_OPTIONS: { value: Density; label: string; hint: string }[] = [
  { value: 'comfortable', label: 'Comfortable', hint: 'Roomy spacing' },
  { value: 'compact', label: 'Compact', hint: 'Tighter, more per screen' },
];

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppearanceSettings() {
  const [theme, setTheme] = useState<Theme>('system');
  const [density, setDensity] = useState<Density>('comfortable');
  const [ready, setReady] = useState(false);

  // Hydrate from localStorage once on mount (the layout script already
  // applied the attributes; this just syncs the controls).
  useEffect(() => {
    setTheme((localStorage.getItem('ekg-theme') as Theme) ?? 'system');
    setDensity((localStorage.getItem('ekg-density') as Density) ?? 'comfortable');
    setReady(true);
  }, []);

  // Keep the document in sync, and follow OS changes while on 'system'.
  useEffect(() => {
    if (!ready) return;
    document.documentElement.setAttribute('data-theme', resolveTheme(theme));
    localStorage.setItem('ekg-theme', theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, ready]);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.setAttribute('data-density', density);
    localStorage.setItem('ekg-density', density);
  }, [density, ready]);

  return (
    <div className="settings-grid">
      <Segmented
        legend="Theme"
        name="theme"
        value={theme}
        options={THEME_OPTIONS}
        onChange={(v) => setTheme(v as Theme)}
      />
      <Segmented
        legend="Density"
        name="density"
        value={density}
        options={DENSITY_OPTIONS}
        onChange={(v) => setDensity(v as Density)}
      />
    </div>
  );
}

function Segmented({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: string;
  options: { value: string; label: string; hint: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <fieldset className="seg-field">
      <legend>{legend}</legend>
      <div className="seg-control" role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={`seg-option${value === o.value ? ' active' : ''}`}
            onClick={() => onChange(o.value)}
            title={o.hint}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
