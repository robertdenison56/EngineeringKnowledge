import type { Metadata } from 'next';
import Link from 'next/link';
import { IngestTabs } from './IngestTabs';

export const metadata: Metadata = {
  title: 'Add knowledge — EKG',
};

export default function IngestPage() {
  return (
    <>
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Add knowledge</h2>
        <Link href="/curation" className="button-link">
          Review queue →
        </Link>
      </div>
      <p className="meta" style={{ maxWidth: 640, marginBottom: '1.2rem' }}>
        Add documents or a project list to the graph. Everything lands in the{' '}
        <Link href="/curation">curation queue</Link> as <strong>unverified</strong>; a curator
        promotes it to the verified graph (PRD&nbsp;P0-2, P0-9).
      </p>
      <IngestTabs />
    </>
  );
}
