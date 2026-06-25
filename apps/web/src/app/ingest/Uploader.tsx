'use client';

import { useActionState, useRef, useState } from 'react';
import Link from 'next/link';
import { ingestUploads, type IngestResult } from './actions';
import { VisibilityFields } from './VisibilityFields';

const ACCEPT = '.pdf,.md,.txt';
const ACCEPTED_EXT = new Set(['.pdf', '.md', '.txt']);

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Drag-drop / file-picker uploader (gaps G1 + interim G2). The selection lives
 * in React state for display, but the authoritative `<input type="file">` is
 * what the form submits — drops are mirrored onto it via DataTransfer so a
 * single native multipart POST carries the binaries to the Server Action.
 */
export function Uploader() {
  const [state, formAction, pending] = useActionState<IngestResult | null, FormData>(
    ingestUploads,
    null,
  );
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function syncToInput(list: File[]) {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(f);
    if (inputRef.current) inputRef.current.files = dt.files;
    setFiles(list);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    syncToInput(Array.from(e.dataTransfer.files));
  }

  const count = files.length;

  return (
    <form action={formAction} className="ingest">
      <label
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          name="files"
          multiple
          accept={ACCEPT}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <span className="dz-strong">Drop files here, or click to choose</span>
        <span className="dz-hint">PDF, Markdown, or text · up to 25&nbsp;MB each · multiple allowed</span>
      </label>

      {count > 0 && (
        <ul className="file-list">
          {files.map((f, i) => {
            const bad = !ACCEPTED_EXT.has(ext(f.name));
            return (
              <li key={`${f.name}-${i}`} className={bad ? 'bad' : ''}>
                <span className="fl-name">{f.name}</span>
                <span className="fl-size">{bad ? 'unsupported type' : fmtSize(f.size)}</span>
              </li>
            );
          })}
        </ul>
      )}

      <label className="batch-tags">
        Tags applied to every file (optional)
        <input name="tags" placeholder="comma-separated, e.g. district-3, drainage" />
      </label>

      <VisibilityFields />

      <button type="submit" disabled={pending || count === 0}>
        {pending
          ? `Ingesting ${count} file${count === 1 ? '' : 's'}…`
          : count > 0
            ? `Ingest ${count} file${count === 1 ? '' : 's'}`
            : 'Ingest'}
      </button>

      {state && <Results state={state} />}
    </form>
  );
}

function Results({ state }: { state: IngestResult }) {
  const ok = state.files.filter((f) => f.ok);
  const failed = state.files.filter((f) => !f.ok);
  return (
    <div className="ingest-results" role="status" aria-live="polite">
      <p className={state.ok ? 'res-ok' : 'res-fail'}>{state.message}</p>

      {ok.length > 0 && (
        <ul className="result-list">
          {ok.map((f) => (
            <li key={f.id}>
              <Link href={`/entities/${encodeURIComponent(f.id ?? '')}`}>{f.title}</Link>{' '}
              <span className="meta">
                {f.type}
                {f.parseStatus ? ` · ${f.parseStatus}` : ''}
                {f.chunks ? ` · ${f.chunks} passage${f.chunks === 1 ? '' : 's'}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {failed.length > 0 && (
        <ul className="result-list failed">
          {failed.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="fl-name">{f.name}</span>{' '}
              <span className="meta">— {f.error}</span>
            </li>
          ))}
        </ul>
      )}

      {state.referencesLinked > 0 && (
        <p className="meta">
          {state.referencesLinked} cross-sheet reference edge
          {state.referencesLinked === 1 ? '' : 's'} linked from callouts.
        </p>
      )}
      {state.referencesUnresolved.length > 0 && (
        <p className="meta">
          Referenced sheet{state.referencesUnresolved.length === 1 ? '' : 's'} not in the graph yet:{' '}
          {state.referencesUnresolved.slice(0, 8).join(', ')}
        </p>
      )}

      {state.ok && (
        <Link href="/curation" className="button-link" style={{ justifySelf: 'start' }}>
          Go to review queue →
        </Link>
      )}
    </div>
  );
}
