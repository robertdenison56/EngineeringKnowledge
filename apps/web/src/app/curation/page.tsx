import Link from 'next/link';
import type { Entity } from '@ekg/core';
import { DEV_CALLER, getStore, listRecentOperations } from '../../lib/store';
import { AccessBadge, ProvenanceLine, TypeBadge, entityHref } from '../../components/ui';
import { rejectEntity, verifyEntity } from './actions';
import { UndoLastButton } from './UndoLastButton';
import { RecentChanges } from './RecentChanges';

/**
 * Flag an OCR-recovered scan whose text came back low- or unknown-confidence
 * (P0-2a). The candidate is `unverified` like every other; this tells the
 * curator WHY to read the source closely before verifying machine-read text.
 */
function OcrReviewBadge({ entity }: { entity: Entity }) {
  const ocr = entity.properties?.ocr as
    | { needsReview?: boolean; lowConfidencePages?: number[]; meanConfidence?: number }
    | undefined;
  if (!ocr?.needsReview) return null;
  const lows = ocr.lowConfidencePages?.length ?? 0;
  const detail =
    lows > 0
      ? `${lows} low-confidence page${lows === 1 ? '' : 's'}`
      : 'confidence could not be measured';
  const mean = ocr.meanConfidence !== undefined ? ` (mean ${ocr.meanConfidence}/100)` : '';
  return (
    <span
      title={`OCR-recovered scan — ${detail}${mean}. Check the source text before verifying.`}
      style={{
        fontSize: '0.72rem',
        fontWeight: 600,
        padding: '0.1rem 0.45rem',
        borderRadius: '999px',
        background: '#fef3c7',
        color: '#92400e',
        border: '1px solid #fcd34d',
        whiteSpace: 'nowrap',
      }}
    >
      ⚠ OCR · review
    </span>
  );
}

export const dynamic = 'force-dynamic';

export default async function CurationPage() {
  const store = await getStore();
  const all = await store.list(DEV_CALLER, { limit: 500 });
  const queue = all.filter((e) => e.provenance.reviewStatus === 'unverified');
  const recent = (await listRecentOperations(8)).map((o) => ({
    id: o.id,
    label: o.label,
    actor: o.actor,
    when: new Date(o.createdAt).toLocaleString(),
    entryCount: o.entryCount,
  }));

  return (
    <>
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Curation workbench</h2>
        <span className="badges">
          <UndoLastButton />
          <Link href="/ingest" className="button-link">
            + Add documents
          </Link>
          <Link href="/capture" className="button-link">
            + Capture knowledge
          </Link>
        </span>
      </div>
      <p className="meta" style={{ marginBottom: '1rem' }}>
        {queue.length} candidate{queue.length === 1 ? '' : 's'} awaiting review. Candidates come
        from ingestion and capture forms; nothing reaches the verified graph without a curator's
        sign-off.
      </p>

      {queue.length === 0 ? (
        <div className="empty">
          The review queue is empty. <Link href="/ingest">Add documents</Link> or{' '}
          <Link href="/capture">capture knowledge</Link> to add candidates.
        </div>
      ) : (
        <div className="cards">
          {queue.map((e) => (
            <article key={e.id} className="card">
              <div className="card-head">
                <Link href={entityHref(e.id)} className="card-title">
                  {e.title}
                </Link>
                <span className="badges">
                  <TypeBadge type={e.type} />
                  <AccessBadge acl={e.acl} />
                  <OcrReviewBadge entity={e} />
                </span>
              </div>
              {e.summary ? <p className="summary">{e.summary}</p> : null}
              <ProvenanceLine entity={e} />
              <div className="actions">
                <form action={verifyEntity}>
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" className="btn-verify">
                    ✓ Verify
                  </button>
                </form>
                <form action={rejectEntity}>
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" className="btn-reject">
                    ✕ Reject
                  </button>
                </form>
              </div>
            </article>
          ))}
        </div>
      )}

      <section style={{ marginTop: '2.5rem' }}>
        <h3 style={{ marginBottom: '0.35rem' }}>Recent changes</h3>
        <p className="meta" style={{ marginBottom: '0.85rem' }}>
          Every edit, merge, and bulk import is staged so it can be rolled back. Undo the most
          recent change from the header, or roll back a specific one here (newest first).
        </p>
        <RecentChanges items={recent} />
      </section>
    </>
  );
}
