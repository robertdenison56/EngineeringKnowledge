'use client';

import { useState } from 'react';
import { Uploader } from './Uploader';
import { CsvImporter } from './CsvImporter';

type Tab = 'documents' | 'projects';

/**
 * Toggle between the two manual/bulk ingestion surfaces (PRD P0-2): document
 * upload (G1) and CSV project-list import (G2 step 3). Both feed the same
 * curation queue; the SharePoint/OneDrive OAuth sync (G2 step 2) will join as a
 * third surface once the connector lands.
 */
export function IngestTabs() {
  const [tab, setTab] = useState<Tab>('documents');

  return (
    <div className="ingest-tabs">
      <div className="tab-row" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'documents'}
          className={`tab${tab === 'documents' ? ' active' : ''}`}
          onClick={() => setTab('documents')}
        >
          Upload documents
        </button>
        <button
          role="tab"
          aria-selected={tab === 'projects'}
          className={`tab${tab === 'projects' ? ' active' : ''}`}
          onClick={() => setTab('projects')}
        >
          Import project list (CSV)
        </button>
      </div>

      {tab === 'documents' ? (
        <>
          <p className="meta tab-intro">
            Upload one or more PDFs, Markdown, or text files. Each runs through the same parsing
            pipeline as bulk ingestion — classification, CAD-native vector parsing, chunking, and
            cross-sheet reference linking.
          </p>
          <Uploader />
        </>
      ) : (
        <>
          <p className="meta tab-intro">
            Seed the graph's project spine from a spreadsheet export. Each row becomes a{' '}
            <strong>project</strong> entity; columns are matched by header name, so your existing
            register imports without reformatting.
          </p>
          <CsvImporter />
        </>
      )}
    </div>
  );
}
