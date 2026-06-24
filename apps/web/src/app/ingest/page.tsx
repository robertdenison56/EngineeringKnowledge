import type { Metadata } from 'next';
import Link from 'next/link';
import { Uploader } from './Uploader';

export const metadata: Metadata = {
  title: 'Add documents — EKG',
};

export default function IngestPage() {
  return (
    <>
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Add documents</h2>
        <Link href="/curation" className="button-link">
          Review queue →
        </Link>
      </div>
      <p className="meta" style={{ maxWidth: 640, marginBottom: '1.2rem' }}>
        Upload one or more PDFs, Markdown, or text files. Each runs through the same
        parsing pipeline as bulk ingestion — classification, CAD-native vector
        parsing, chunking, and cross-sheet reference linking — and lands in the{' '}
        <Link href="/curation">curation queue</Link> as <strong>unverified</strong>.
        A curator promotes it to the verified graph (PRD&nbsp;P0-2, P0-9).
      </p>
      <Uploader />
    </>
  );
}
