import Link from 'next/link';
import { DEV_CALLER, getStore } from '../../lib/store';
import { listTrash } from '../../lib/trash';
import { ProvenanceLine, TypeBadge, entityHref } from '../../components/ui';
import { bulkReject, bulkVerify, rejectEntity, restoreRejected, verifyEntity } from './actions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function CurationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const store = await getStore();
  // High ceiling then filter: the queue must never silently truncate — a
  // candidate a curator cannot see is a candidate that never gets reviewed.
  const all = await store.list(DEV_CALLER, { limit: 10_000 });
  const queue = all.filter((e) => e.provenance.reviewStatus === 'unverified');
  const pageCount = Math.max(1, Math.ceil(queue.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pageCount);
  const shown = queue.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const trash = await listTrash(10);

  return (
    <>
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Curation workbench</h2>
        <span className="badges">
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
        curator&apos;s sign-off. Rejecting moves a candidate to the trash below, not into oblivion.
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

      {trash.length > 0 ? (
        <>
          <h2 style={{ marginTop: '1.6rem' }}>Recently rejected</h2>
          <p className="meta" style={{ marginBottom: '0.8rem' }}>
            Rejected candidates are kept here (and in the audit trail) so a misclick is
            recoverable. Restore puts the candidate back in the queue with its document text
            intact.
          </p>
          <div className="cards">
            {trash.map((t) => (
              <article key={t.key} className="card">
                <div className="card-head">
                  <span className="card-title">{t.entity.title}</span>
                  <span className="badges">
                    <TypeBadge type={t.entity.type} />
                  </span>
                </div>
                <p className="meta">
                  Rejected {t.rejectedAt.slice(0, 16).replace('T', ' ')} by {t.rejectedBy}
                  {t.chunks.length > 0 ? ` · ${t.chunks.length} document passages retained` : ''}
                </p>
                <form action={restoreRejected} className="actions">
                  <input type="hidden" name="key" value={t.key} />
                  <button type="submit" className="btn-verify">
                    ↩ Restore to queue
                  </button>
                </form>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
