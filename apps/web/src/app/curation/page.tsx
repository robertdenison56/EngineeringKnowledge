import Link from 'next/link';
import type { Entity } from '@ekg/core';
import { getCaller, getStore, listRecentOperations } from '../../lib/store';
import { AccessBadge, ProvenanceLine, TypeBadge, entityHref } from '../../components/ui';
import { bulkReject, bulkVerify, rejectEntity, verifyEntity } from './actions';
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

const PAGE_SIZE = 50;

export default async function CurationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const store = await getStore();
  const caller = await getCaller();
  // High ceiling then filter: the queue must never silently truncate — a
  // candidate a curator cannot see is a candidate that never gets reviewed.
  const all = await store.list(caller, { limit: 10_000 });
  const queue = all.filter((e) => e.provenance.reviewStatus === 'unverified');
  const pageCount = Math.max(1, Math.ceil(queue.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pageCount);
  const shown = queue.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
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
        {queue.length} candidate{queue.length === 1 ? '' : 's'} awaiting review
        {pageCount > 1 ? ` (page ${page} of ${pageCount})` : ''}. Candidates come from ingestion,
        capture forms, and assistant proposals; nothing reaches the verified graph without a
        curator&apos;s sign-off. A mistaken reject rolls back from Recent changes below.
      </p>

      {queue.length === 0 ? (
        <div className="empty">
          The review queue is empty. <Link href="/ingest">Add documents</Link> or{' '}
          <Link href="/capture">capture knowledge</Link> to add candidates.
        </div>
      ) : (
        <>
          {/* The bulk form's checkboxes live inside the per-item cards and
              associate here via the HTML form attribute, so each card can
              also carry its own single-item verify/reject forms (no nesting). */}
          <form id="bulk-queue" className="actions" style={{ marginBottom: '0.8rem' }}>
            <button type="submit" formAction={bulkVerify} className="btn-verify">
              ✓ Verify selected
            </button>
            <button type="submit" formAction={bulkReject} className="btn-reject">
              ✕ Reject selected
            </button>
          </form>
          <div className="cards">
            {shown.map((e) => (
              <article key={e.id} className="card">
                <div className="card-head">
                  <span>
                    <input
                      type="checkbox"
                      name="ids"
                      value={e.id}
                      form="bulk-queue"
                      aria-label={`Select ${e.title}`}
                      style={{ marginRight: '0.6rem' }}
                    />
                    <Link href={entityHref(e.id)} className="card-title">
                      {e.title}
                    </Link>
                  </span>
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
                  <Link href={entityHref(e.id)} className="button-link">
                    Review &amp; edit
                  </Link>
                </div>
              </article>
            ))}
          </div>
          {pageCount > 1 ? (
            <p className="meta" style={{ marginTop: '0.8rem' }}>
              {page > 1 ? <Link href={`/curation?page=${page - 1}`}>← Newer</Link> : null}
              {page > 1 && page < pageCount ? ' · ' : null}
              {page < pageCount ? <Link href={`/curation?page=${page + 1}`}>Older →</Link> : null}
            </p>
          ) : null}
        </>
      )}

      <section style={{ marginTop: '2.5rem' }}>
        <h3 style={{ marginBottom: '0.35rem' }}>Recent changes</h3>
        <p className="meta" style={{ marginBottom: '0.85rem' }}>
          Every edit, merge, and bulk import is staged so it can be rolled back. Undo the most
          recent change from the header, or roll back a specific one here (newest first). A
          rejected candidate is restored in full — fields, document passages, and edges.
        </p>
        <RecentChanges items={recent} />
      </section>
    </>
  );
}
