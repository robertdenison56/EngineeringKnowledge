# Ingestion Pipeline v0 (PRD P0-2, P0-2a)

Walks a folder, classifies each file, and queues **unverified** candidate
entities in the shared SQLite database — they appear in the workspace app's
curation workbench (`/curation`) for review. Nothing reaches the verified
graph without a curator.

```sh
# from the repo root, into the web app's database:
npm run ingest --workspace @ekg/ingestion -- services/ingestion/samples \
  --db apps/web/.data/ekg.db
```

Classification v0 (filename-based, conservative by design):

| Pattern | Type | Anchor |
|---|---|---|
| MasterFormat number (`07 84 00 …`) | `spec-section` | `specSection` |
| Sheet number (`A-501 …`) | `document` | `sheet` |
| `RFI…` | `rfi` | — |
| `Lesson…` | `lesson-learned` | — |
| anything else | `document` | — |

Text files (`.txt`, `.md`) get content summaries. **PDFs are recorded as
classified-but-unparsed** — class-specific extraction (layout-aware text,
MasterFormat splitting, title blocks, confidence-gated OCR) is gated on the
PRD Open Question 8 parser spike. Recording "parsing pending" honestly beats
ingesting garbage text.

Next: SharePoint/OneDrive OAuth sync replaces the folder walk; the
candidate model and curation flow stay the same.
