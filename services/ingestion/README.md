# Ingestion Pipeline (PRD P0-2, P0-2a)

Placeholder — not yet scaffolded.

Connects to sources (SharePoint/OneDrive first), classifies documents, and
runs class-specific PDF parsing: layout-aware extraction for text PDFs,
MasterFormat splitting for spec books, per-sheet title-block extraction for
drawing sets, and confidence-gated OCR for scans. Extracted candidates land
in the curation workbench, never directly in the verified graph.

Likely Python (PDF/OCR ecosystem); the buy-vs-build parser spike is PRD Open
Question 8 and gates this service's design.
