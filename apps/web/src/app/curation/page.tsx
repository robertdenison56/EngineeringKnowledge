import Link from 'next/link';
import { DEV_CALLER, getStore } from '../../lib/store';
import { ProvenanceLine, TypeBadge, entityHref } from '../../components/ui';
import { rejectEntity, verifyEntity } from './actions';

export const dynamic = 'force-dynamic';

export default async function CurationPage() {
  const store = await getStore();
  const all = await store.list(DEV_CALLER, { limit: 500 });
  const queue = all.filter((e) => e.provenance.reviewStatus === 'unverified');

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
    </>
  );
}
