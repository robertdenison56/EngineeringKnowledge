'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { importProjectCsv, type CsvImportResult } from './actions';
import { VisibilityFields } from './VisibilityFields';

const SAMPLE = `name,number,client,discipline,status
Riverside Transit Center,2024-118,Metro Authority,Structural,Construction
Hilltop Library Renovation,2025-006,City of Ashford,Architectural,Design`;

/**
 * CSV project-list import (PRD P0-2, G2 step 3). Paste a list or upload a
 * `.csv`/`.tsv`; rows become `project` candidates in the curation queue. The
 * header is matched by name (synonyms accepted), so a firm's existing project
 * register imports without reformatting. Nothing is auto-verified.
 */
export function CsvImporter() {
  const [state, formAction, pending] = useActionState<CsvImportResult | null, FormData>(
    importProjectCsv,
    null,
  );
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <form action={formAction} className="ingest">
      <label className="csv-paste">
        Paste a project list (CSV or tab-separated)
        <textarea
          name="csv"
          rows={7}
          spellCheck={false}
          placeholder={SAMPLE}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
      </label>

      <div className="csv-or">
        <span>or</span>
      </div>

      <label className="csv-file">
        <span className="dz-strong">Choose a .csv / .tsv file</span>
        <input
          type="file"
          name="file"
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
        />
        {fileName && <span className="dz-hint">{fileName}</span>}
      </label>

      <p className="meta csv-cols">
        Recognized columns: <code>name</code> (required), <code>number</code>, <code>client</code>,{' '}
        <code>discipline</code>, <code>status</code>, <code>location</code>, <code>url</code>,{' '}
        <code>description</code>, <code>tags</code>. Unknown columns are ignored.{' '}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setCsv(SAMPLE);
            setFileName(null);
          }}
        >
          Use a sample
        </button>
      </p>

      <label className="batch-tags">
        Tags applied to every project (optional)
        <input name="tags" placeholder="comma-separated, e.g. transit, 2025-program" />
      </label>

      <VisibilityFields />

      <button type="submit" disabled={pending || (csv.trim() === '' && !fileName)}>
        {pending ? 'Importing…' : 'Import projects'}
      </button>

      {state && <CsvResults state={state} />}
    </form>
  );
}

function CsvResults({ state }: { state: CsvImportResult }) {
  return (
    <div className="ingest-results" role="status" aria-live="polite">
      <p className={state.ok ? 'res-ok' : 'res-fail'}>{state.message}</p>

      {state.recognized.length > 0 && (
        <p className="meta">
          Mapped columns: {state.recognized.join(', ')}
          {state.ignored.length > 0 ? ` · ignored: ${state.ignored.join(', ')}` : ''}
        </p>
      )}

      {state.imported.length > 0 && (
        <ul className="result-list">
          {state.imported.map((p) => (
            <li key={p.id}>
              <Link href={`/entities/${encodeURIComponent(p.id)}`}>{p.title}</Link>{' '}
              <span className="meta">project{p.number ? ` · ${p.number}` : ''}</span>
            </li>
          ))}
        </ul>
      )}

      {state.rowErrors.length > 0 && (
        <ul className="result-list failed">
          {state.rowErrors.map((e) => (
            <li key={e.line}>
              <span className="fl-name">Line {e.line}</span>{' '}
              <span className="meta">— {e.message}</span>
            </li>
          ))}
        </ul>
      )}

      {state.ok && (
        <Link href="/curation" className="button-link" style={{ justifySelf: 'start' }}>
          Go to review queue →
        </Link>
      )}
    </div>
  );
}
