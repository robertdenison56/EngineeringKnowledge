# PRD: Engineering Knowledge Graph for AEC Firms

| | |
|---|---|
| **Product** | Engineering Knowledge Graph (working name: "EKG") |
| **Status** | Draft v0.2 |
| **Author** | Robert Denison |
| **Last updated** | 2026-06-16 |
| **Target release** | v1 GA — phased, see [Timeline](#timeline-considerations) |

---

## Problem Statement

AEC (Architecture, Engineering, Construction) firms run on institutional knowledge — design details that worked, products that failed, code interpretations a jurisdiction accepted, lessons learned from RFIs and change orders — but that knowledge lives in silos: project folders, retired engineers' heads, Procore/ACC archives, and email. When staff ask general-purpose AI assistants (ChatGPT, Claude, Microsoft 365 Copilot) engineering questions, the assistants answer from public training data with no awareness of the firm's standards, precedents, or hard-won failures, producing confident but firm-inaccurate answers in a domain where errors carry liability and life-safety consequences.

The cost of not solving this, in order of severity: firms **repeat mistakes already paid for** on past projects (rework, change orders, and — on structural/life-safety work — liability exposure); an **aging workforce walks out the door** with undocumented expertise the firm cannot recover (industry surveys put a large share of senior engineers within a decade of retirement); and engineers **burn billable hours re-finding precedents** that already exist somewhere in the firm. (The oft-cited "knowledge workers spend 15–30% of their time searching" figure traces to early-2000s IDC studies and is contested; we treat it as directional color, not a load-bearing claim — the rework and attrition costs are the real driver.) Meanwhile, staff are already using LLMs — ungrounded — which converts a knowledge-management gap into an accuracy and liability risk.

## Solution Overview

A multi-tenant knowledge platform with two halves: a **knowledge workspace app** where firms build, curate, and visually explore their knowledge graph, and **multiple gateways** so the AI assistants firms already use can ground their answers in it. The graph holds entities like projects, details, specifications, standards, lessons learned, and experts, linked by typed relationships.

**The knowledge workspace app (web)** is how firms *implement and view* the knowledge: an interactive graph explorer, entity detail pages, faceted search, a curation workbench for reviewing auto-extracted knowledge, guided capture forms, and an ingestion setup wizard (see P0-9). Citations in assistant answers deep-link back into it.

**The gateways** are how knowledge reaches users where they already work:

1. **A remote MCP (Model Context Protocol) server** — the canonical gateway. One server connects to **Claude** (claude.ai connectors, Claude Code, API), **ChatGPT** (MCP-based connectors), and **Microsoft 365 Copilot** (federated connectors and declarative-agent actions are both MCP-based).
2. **A Microsoft Graph synced connector** — indexes knowledge items into the Microsoft 365 semantic index so Copilot, Microsoft Search, and Context IQ surface them natively without the user invoking an agent.
3. **A REST retrieval API** — for firms embedding retrieval into their own tools.

Every answer path returns **provenance**: source document, project, author, date, and a confidence/review status — because in engineering, an uncited answer is a liability.

```
                          ┌────────────────────────────┐
  Ingestion               │   Engineering Knowledge    │           Gateways
  ─────────               │          Graph             │           ────────
  SharePoint/OneDrive ──▶ │                            │ ──▶ MCP server ──▶ Claude
  Procore / ACC       ──▶ │  entities + relationships  │              └───▶ ChatGPT
  Network drives      ──▶ │  + source documents        │              └───▶ M365 Copilot (federated / agent)
  Manual curation     ──▶ │  + permissions (ACLs)      │ ──▶ Graph synced connector ──▶ M365 Copilot / Search
                          │                            │ ──▶ REST retrieval API ──▶ firm's own tools
                          └─────────────▲──────────────┘
                                        │ curate / explore / visualize
                          ┌─────────────┴──────────────┐
                          │  Knowledge Workspace App   │ ◀── citation deep links from
                          │  graph explorer · entity   │     assistant answers
                          │  pages · curation · forms  │
                          └────────────────────────────┘
```

### Where the defensibility lives

Two of this product's surface features are *not* the moat, and we should not position on them:

- **"Ground your AI assistant in company knowledge"** is now table stakes — Microsoft (Copilot + Work IQ), Glean, and others all do it horizontally.
- **"Connect to multiple assistants"** is a distribution choice, not a differentiator — Glean already grounds ChatGPT/Claude/Gemini through an MCP gateway, and Microsoft grounds Copilot. Breadth helps adoption; it does not defend the position.

The defensible wedge is the **intersection no horizontal or single-vendor player occupies**:

1. **AEC-native document understanding** — drawing sets parsed to sheet/title-block/region level, spec books split by MasterFormat section, CAD-native vector parsing, OCR-confidence gating, and page/sheet-anchored citations (P0-2a). Glean, Work IQ, and AEC intranet tools treat these as opaque files; we turn them into a navigable graph.
2. **Provenance and EOR-liability rigor** — every answer carries source, author, date, and review status; superseded/known-bad items are flagged, not silently served (P0-8). This is a vertical trust requirement horizontal tools deprioritize.
3. **Cross-vendor source neutrality** — we span M365 **and** Procore/ACC **and** network drives. This is the structural advantage over both the platform walled gardens (Autodesk, Procore building AI on *their* data) and the M365-centric context layers (Work IQ). No single platform will build this, because it spans their competitors.

The gateways and the workspace app are *how* this reaches users; the three points above are *why* a firm picks us over Copilot-plus-a-SharePoint-connector. See [Competitive Landscape](#competitive-landscape).

## Goals

1. **Grounded accuracy**: ≥ 85% of assistant answers to firm-knowledge questions cite a correct, permission-appropriate source from the graph (measured by monthly evaluation set per tenant).
2. **Findability**: reduce median time for an engineer to locate a relevant precedent (detail, spec section, lesson learned) from hours to **under 5 minutes**, via whichever assistant they already use.
3. **Adoption where users already are**: ≥ 60% of a customer firm's technical staff issue at least one grounded query per month within 90 days of rollout — *without* requiring them to adopt a new chat interface.
4. **Knowledge capture**: each active tenant adds or curates ≥ 50 knowledge items per month by month 6 (leading indicator that the graph compounds rather than decays).
5. **Business**: 10 paying design-team customers (50–2,000 staff) within 2 quarters of GA. The differentiator vs. horizontal KM and single-ecosystem tools is the vertical wedge (AEC-native parsing + provenance + cross-vendor coverage — see [Where the defensibility lives](#where-the-defensibility-lives)); gateway breadth is an adoption lever, not the moat.

### Research arcs

**The objective.** Turn the two existing projects into two public, measured artifacts that a research team can evaluate — EKG for the Knowledge Team (#14), RoadDraft for Domain Scaling (#13) — while producing the Python and evaluation-framework proof that the Tier 1 and Tier 2 applications (FDE, Applied AI Architect) need this month.

**The rule for both:** bounded scope with a number at the end. Neither project gets "finished." Each gets a milestone that ships a repo, a dataset, a results table, and a writeup.

#### Arc 1 — EKG research arc (Python, ~8–9 weeks, target mid-November 2026)

**Goal:** a public, retrieval-grounded benchmark on US transportation standards, plus a research note with measured results.

**Position against prior art:** AECBench (Tongji, 2025), DesignQA (2024), Qwen-BIM (2026). None cover US transportation standards, none are retrieval-grounded (model is given the documents and tools), none are deterministically scored. That is the gap.

1. **Hard eval set.** 120–200 questions over the Caltrans HDM, Standard Plans, and Standard Specs (all public). Four buckets: single-table lookups (K values, SSD, superelevation); multi-hop cross-references (HDM → Standard Plan → spec section); unit and edition traps; "not in the document" refusals. Every answer carries a source anchor (document, page, table). Harness runs closed-book, vanilla RAG, and EKG's tools. Deterministic scoring wherever the answer is a number or citation; LLM-judge only for the rest. Build in Inspect or the verifiers format. *Done when:* dataset on Hugging Face, harness on GitHub, results table for 3+ frontier models.
2. **Grounding track.** Port the vision-annotation grounding pipeline (the 44% → 76% result, [ADR 0007](docs/decisions/0007-vlm-fusion.md)) to Python and re-run it on public Caltrans bid plan sets. *Done when:* the number reproduces from a public repo on public drawings.
3. **Agentic search study.** On the same questions, compare single-shot RAG, tool-loop agentic search, and graph traversal via EKG's MCP tools. *Done when:* accuracy, steps, tokens, and a failure-mode taxonomy are reported per method.
4. **First fine-tune.** Fine-tune a small embedding model or reranker on query → passage pairs mined from the corpus. Report recall@k before and after on the held-out set, then the generalization check: train on the HDM, test on the Standard Specs. Runs on the 4060. Optional harder variant: QLoRA a 3B model to emit page-anchored citations; measure citation validity. *Done when:* baseline, treatment, and result are in one table.
5. **Research note.** Setup, metric, baselines, results, failure taxonomy, limitations, next steps. *Done when:* published (GitHub README plus LinkedIn/HN cross-post) and linked from the resume.

## Non-Goals

- **Not a chatbot of our own.** The product's bet is meeting users inside ChatGPT, Claude, and Copilot for conversational Q&A. The knowledge workspace app (P0-9) is a full first-party product for building, curating, and visually exploring the graph — but it deliberately has no chat interface. Building one would dilute the gateway bet and compete with the host platforms.
- **Not a document management system or common data environment.** We index and link to content in SharePoint, Procore, ACC, etc.; we do not become the system of record, handle drawing version control, or replace ISO 19650 CDE workflows. Source systems remain authoritative.
- **Not engineering judgment.** The system retrieves and grounds; it does not stamp, seal, or validate designs. Responsibility remains with the Engineer of Record. Product copy, onboarding, and answer footers must reinforce this (legal requirement, see Open Questions).
- **Not BIM/IFC model intelligence in v1.** Parsing Revit/IFC geometry into the graph is high-value but a separate, large effort (P2). v1 ingests documents and structured records, not models.
- **Not government/classified environments in v1.** ITAR/CUI/FedRAMP/GCC High requirements change hosting, staffing, and connector availability (Copilot federated connectors aren't available in DoD clouds). Commercial cloud only for v1; GovCloud is a P2 architectural consideration.
- **Not cross-firm knowledge sharing.** Tenants are hard-isolated. No benchmarking, pooling, or "industry graph" in v1 — client confidentiality and NDA exposure make this a trust-killer if mishandled (P2, opt-in only).
- **Not a replacement for the host platforms' own context layers** (Microsoft Work IQ, Glean's enterprise graph, etc.). We *complement* them: we supply AEC-grounded, provenance-rich, page/sheet-anchored knowledge those generic layers cannot extract from a drawing set or spec book, and feed it to whichever assistant the firm uses. When a firm asks "why not just Copilot + Work IQ?", the answer is the vertical wedge — not a competing horizontal index.

## Competitive Landscape

The problem is validated — the AEC software market is ~$10–11B (2026), AI took ~46% of construction-tech VC in Q1 2025, and incumbents are both building ("design brains," "lessons travel with the project") and buying (Trimble's 2026 acquisition of Document Crunch). Validation cuts both ways: every adjacent square is occupied or being entered, so we win on the *intersection* (see [Where the defensibility lives](#where-the-defensibility-lives)), not on either axis alone.

| Competitor | What it is | Overlap | Where we differ |
|---|---|---|---|
| **Glean** | Horizontal enterprise graph + MCP gateway; model-agnostic (grounds ChatGPT/Claude/Gemini); 275+ connectors; permission-aware. Category leader (~$200M ARR). | **Highest** — this *is* the multi-gateway, permissioned-graph thesis, already proven at scale. | No AEC ontology; treats drawings/specs as opaque files; no MasterFormat/CAD/sheet parsing; no EOR provenance; Procore/ACC not first-class. |
| **Microsoft Copilot + Work IQ** | Work IQ is Copilot's semantic context layer (ontologies, glossaries, agentic skills) over M365/Dynamics/Dataverse; APIs GA mid-2026. | High on "understand my work data." | Horizontal and M365-data-centric; no drawing/spec/CAD understanding; won't index Procore/ACC as first-class. We feed it, not fight it. |
| **Knowledge Architecture — Synthesis** | Incumbent AEC intranet/KM (~170 firms), adding AI Search over intranet content. | High on "AEC firm knowledge" + AI answers. | Intranet-content-centric (not drawings/specs); single surface, not multi-assistant; no document-parsing depth. |
| **Skema.AI** | BIM knowledge-reuse engine; knowledge graph of a firm's past Revit designs ("Design Catalog"). | High on "firm knowledge graph of past work." | Revit/BIM-model-centric (our P2); aimed at *generating* designs, not grounded Q&A with provenance. |
| **Trunk Tools** | Jobsite document Q&A grounded in project docs, with citations. | Medium — same "cited answers from docs" UX. | Project/field-scoped, construction phase; not cross-project firm institutional knowledge. |
| **Document Crunch** (→ Trimble) | Contract/spec risk & compliance AI. | Narrow (contracts). | We are cross-discipline knowledge, not contractual-risk review. |
| **Procore** (AI / Helix / Agent Builder) | Construction-management platform building its own copilot + agent builder. | Medium — but **owns** the construction-phase data. | Design-side + cross-vendor; Procore is a walled-garden threat we route around by spanning sources. |
| **Autodesk Assistant** (Revit/Forma/AutoCAD/Civil 3D) + "design & make intelligence" | In-tool AI; explicit "lessons travel with the project" cross-project reuse. | **Highest strategic threat** — owns the authoring tools and the data. | We are tool-agnostic and provenance-first; Autodesk locks value into its own stack, we span stacks. |

**Positioning summary.** Horizontal players (Glean, Work IQ) own breadth but not AEC depth; vertical players (Skema, Trunk Tools, Document Crunch, Synthesis) each own a slice (BIM reuse, field Q&A, contracts, intranet) but not the cross-project, cross-vendor, provenance-first knowledge layer; platform players (Autodesk, Procore) own data and workflow but only within their own walls. Our position is the AEC-native, provenance-rich, cross-vendor knowledge layer that grounds whatever assistant the firm already uses — see [Key Risks](#key-risks) for how the platform players could contest it.

## Users & Personas

- **Project Engineer / Architect ("Priya")** — mid-level technical staff. Wants fast, trustworthy answers with sources while producing deliverables. Primary consumer; works in whichever assistant the firm licenses.
- **Knowledge Manager / Technical Director ("Marcus")** — owns standards, details libraries, lessons-learned programs. Primary curator; decides what enters the graph and its review status.
- **Principal / QA Reviewer ("Elena")** — accountable for quality and liability. Cares about provenance, review status, and that superseded/known-bad details are flagged, not just findable.
- **IT / Security Admin ("Dana")** — deploys connectors, maps permissions, answers the security questionnaire. Decides whether the product gets bought. Lives in Entra ID and the M365 admin center.

## User Stories

**Consumption (Priya, Elena)**
1. As a project engineer, I want to ask Copilot/ChatGPT/Claude "how have we detailed a curtain-wall-to-slab fire-stop condition on past healthcare projects?" and get answers grounded in our firm's details with links to the source projects, so that I reuse proven work instead of re-deriving it.
2. As a project engineer, I want every grounded answer to show project, author, date, and review status, so that I can judge whether to rely on it.
3. As a QA principal, I want superseded or known-problematic details to be flagged in answers (not silently served), so that the assistant doesn't propagate past mistakes.
4. As a project engineer, I want to ask "who in the firm has designed mass-timber structures in seismic category D?" and get people, projects, and documents, so that I can find the expert, not just the file.
5. As a project engineer, when the graph has no relevant knowledge, I want the assistant to say so rather than fall back silently to generic LLM knowledge, so that I never mistake a public-data guess for firm precedent. *(Edge case — core to the accuracy promise.)*
6. As a project engineer, I want to click a citation in an assistant answer and land on that item's page in the app — seeing its source documents, related details, and the projects it was used on — so that I can verify the answer and explore what surrounds it.
7. As a QA principal, I want to visually explore the graph around a project or detail (filtering by discipline, relationship type, or review status), so that I can spot gaps, stale items, and undocumented connections that a search box would never reveal.

**Curation (Marcus)**
8. As a knowledge manager, I want to point the system at a SharePoint library or Procore project and have documents auto-ingested, classified (spec, detail, RFI, lesson learned…), and linked to project/discipline entities, so that the graph grows without manual data entry.
9. As a knowledge manager, I want a curation workbench where I review, correct, merge, or reject auto-extracted entities and relationships before they're marked "verified," so that the graph stays trustworthy without me editing raw data.
10. As a knowledge manager, I want to capture a lesson learned in a guided form (what happened, root cause, affected systems, applicable standards) linked to its project and RFIs, so that it surfaces in future relevant queries.
11. As a knowledge manager, I want usage analytics — top queries, zero-result queries, most-cited items — so that I can target curation where demand is.

**Administration (Dana)**
12. As an IT admin, I want to deploy the Copilot connection from the Microsoft 365 admin center and the Claude/ChatGPT connectors from those platforms' admin consoles, with Entra ID SSO, so that rollout is a configuration task, not a development project.
13. As an IT admin, I want graph items to carry ACLs mapped from source systems and Entra groups, so that a user can never retrieve knowledge through an assistant that they couldn't open in the source system. *(Hard requirement; see P0-7.)*
14. As an IT admin, I want per-user, per-gateway audit logs of queries and retrieved items, so that I can satisfy client-confidentiality and insurance audits.

## Requirements

### P0 — Must-Have (v1 cannot ship without)

**P0-1. Knowledge graph core**
AEC-native ontology with at minimum these entity types: `Project`, `Document`, `DesignDetail`, `SpecSection` (MasterFormat-coded), `Standard/Code` (e.g., IBC, ASCE 7, ACI 318 — references, not full text), `LessonLearned`, `RFI`, `Person/Expert`, `Client`, `Material/Product`, `Discipline`. Typed relationships including `usedIn`, `supersedes`, `authoredBy`, `compliesWith`, `hadIssue`, `appliesTo`.
- [ ] Curators can create/edit/merge entities and relationships via the knowledge workspace app (P0-9)
- [ ] Every entity carries: source link, author, dates, review status (`unverified` / `verified` / `superseded` / `deprecated`), and ACL
- [ ] Ontology is extensible per tenant (custom entity/relationship types) without code changes

**P0-2. Ingestion — SharePoint/OneDrive + manual + bulk**
- [ ] OAuth connection to SharePoint/OneDrive; selected libraries sync on schedule with change detection
- [ ] Pipeline classifies document type (spec, drawing set, RFI, submittal, calc package, report…), extracts candidate entities/relationships, and queues them in the curation workbench (P0-9)
- [ ] CSV/bulk import for project lists
- [ ] Source-system permissions are captured at ingestion and stored as item ACLs

**P0-2a. PDF parsing & document understanding**
PDFs are the dominant container for AEC knowledge — drawing sets, spec books, RFIs, submittals, calc packages, scanned legacy archives — and each class defeats generic text extraction differently. The pipeline must handle them as distinct classes, not as one "extract text" step:
- [ ] **Text PDFs**: layout-aware extraction (headings, lists, tables preserved as structure) — not raw text streams — so document structure survives into entity extraction
- [ ] **Spec books**: auto-split by MasterFormat section numbers into `SpecSection` entities; citation anchors at the section level, never the whole-book level
- [ ] **Drawing sets**: title-block extraction per sheet (sheet number, title, revision, discipline, date) producing sheet-level entities — a drawing set ingests as a navigable set of sheets, never as one text blob
- [ ] **Scanned documents**: OCR with per-page confidence scoring, including rotated and large-format pages; pages below the confidence threshold are flagged for human review in the curation workbench — low-confidence text is never silently promoted to `verified` knowledge
- [ ] **Page/sheet anchors**: every document-derived entity records the page or sheet it came from, so gateway citations and app deep links (P0-9) resolve to the exact location, not just the file
- [ ] **Acceptance**: a parsing test corpus assembled from design partners (text PDFs, Bluebeam-generated drawing sets, scanned legacy sets, spec books) with per-class extraction-quality thresholds set during the Phase 1 spike (Open Question 8); release-gated on meeting them

**P0-3. MCP gateway (canonical)**
A remote MCP server (Streamable HTTP) exposing the graph. This single server is the integration surface for all three required platforms.
- [ ] Tools: `search` (hybrid semantic + graph-aware retrieval, returns scored results with citations), `fetch` (full item by ID) — **named and shaped to meet ChatGPT connector requirements**, plus richer tools: `traverse` (follow relationships from an entity), `find_experts`, `get_project_context`
- [ ] OAuth 2.1 authorization with dynamic client registration; identity federates to the tenant's Entra ID so per-user ACLs apply on every tool call
- [ ] Every tool response includes provenance fields (source URL, project, author, date, review status) and is permission-trimmed to the calling user
- [ ] Tenant isolation enforced at the data layer (no cross-tenant retrieval possible, verified by automated tests)

**P0-4. Claude connectivity**
- [ ] MCP server connects as a claude.ai custom connector (individual add and Team/Enterprise admin-managed deployment)
- [ ] Works from Claude Code (`mcp add`) and via the Claude API MCP connector for firms building agents
- [ ] Verified end-to-end: a permissioned user asks a firm-knowledge question in claude.ai and receives a cited, ACL-correct answer

**P0-5. ChatGPT connectivity**
- [ ] Same MCP server registers as a ChatGPT connector; `search`/`fetch` conform to OpenAI's connector spec so it works in chat and deep research
- [ ] Admin-deployable to ChatGPT Business/Enterprise/Edu workspaces; documented setup path for Plus/Pro via developer mode
- [ ] Verified end-to-end as in P0-4

**P0-6. Microsoft 365 Copilot connectivity**
Two supported paths, both shipping in v1:
- [ ] **Federated connector (MCP-based)**: Copilot retrieves from the MCP gateway at query time — no data leaves the platform into Graph; correct for confidential/regulated content
- [ ] **Declarative agent** ("[Firm] Engineering Knowledge") built on the MCP action via Microsoft 365 Agents Toolkit, distributed through the tenant app catalog, with Entra SSO
- [ ] Verified end-to-end in Copilot Chat: cited, ACL-correct answers
- [ ] Admin deployment documented for the M365 admin center (Dana can do it in < 1 day without our help)

**P0-7. Permissions, tenancy, and audit**
- [ ] ACL enforcement on every retrieval path (MCP, Graph connector, REST); user identity resolved per-request via OAuth/Entra — *acceptance: a red-team test suite proves no item is retrievable by a user lacking source-system access, across all gateways*
- [ ] Per-tenant encryption at rest; SOC 2 Type II program started before GA (report is a P1 deliverable)
- [ ] Immutable audit log: who asked what, through which gateway, which items were retrieved

**P0-8. Provenance and honesty in answers**
- [ ] Tool responses are structured so host assistants naturally cite (title + deep link per result)
- [ ] `search` returns an explicit `no_results` state with guidance text instructing the model to say the firm graph has no answer — never to substitute general knowledge silently
- [ ] Items flagged `superseded`/`deprecated` are returned only with a prominent warning field, never as clean results

**P0-9. Knowledge workspace app (web)**
The first-party web application where firms implement, curate, and visually explore the graph. Assistants are the primary *query* surface; the app is the primary *build, review, and visualization* surface — and the destination for every citation link.
- [ ] **Interactive graph explorer**: visualize the neighborhood around any entity; filter by entity type, relationship type, discipline, project, and review status; expand/collapse nodes and click through to entity pages; usable on a graph of 100k+ entities without degrading (progressive loading, not a hairball)
- [ ] **Entity detail pages**: properties, provenance, review status, linked source documents (deep links to SharePoint/Procore/ACC), related entities, and "cited in answers" usage count; inline editing for users with curator role
- [ ] **Faceted search and browse**: full-text search across the graph with filters (project, discipline, MasterFormat section, review status, date range); results show provenance at a glance
- [ ] **Curation workbench**: queue of auto-extracted entities/relationships with accept / edit / reject / merge actions, diff-style preview against existing entities, and bulk operations; median time to process an item < 2 minutes
- [ ] **Guided capture forms**: structured entry for `LessonLearned` and `DesignDetail` (user story 10), with type-ahead linking to existing projects, standards, and people
- [ ] **Ingestion setup wizard**: connect a source (SharePoint v1; Procore/ACC at P1-2), pick libraries/projects, confirm permission mapping, and monitor sync health — designed so Marcus can do it without IT after initial OAuth consent
- [ ] **Stable deep links**: every entity has a permanent URL; assistant citations resolve to the entity page (with ACL check) so "view the knowledge" is one click from any gateway; document-derived entities resolve to the specific page or sheet via P0-2a anchors
- [ ] **Roles and SSO**: viewer / contributor / curator / admin roles; sign-in via Entra ID SSO; all views permission-trimmed identically to the gateways (P0-7)

### P1 — Nice-to-Have (fast follows)

- **P1-1. Microsoft Graph synced connector**: index knowledge items into the M365 semantic index (`externalItem` schema, ACLs mapped to Entra) so Copilot and Microsoft Search surface them natively without invoking an agent. Biggest single adoption lever for Copilot-first firms; P1 only because the federated path (P0-6) already satisfies "connects to Copilot."
- **P1-2. Procore and Autodesk Construction Cloud ingestion**: RFIs, submittals, and issues auto-linked to projects — the richest source of lessons learned. **Strategically this is more than a fast-follow: cross-vendor source neutrality (spanning M365 *and* Procore/ACC) is a core moat** vs. both the platform walled gardens and the M365-centric context layers (see [Competitive Landscape](#competitive-landscape)). Candidate to pull into P0 if a design partner's lessons-learned corpus lives primarily in Procore/ACC rather than SharePoint; the GA gate and timeline assume SharePoint-first, so promoting it is a deliberate scope decision, not a default.
- **P1-3. Contradiction & staleness detection**: flag when a new standard supersedes details in the graph, or when two `verified` items conflict; queue for curator review.
- **P1-4. Usage analytics dashboard in the workspace app** (user story 11): query themes, zero-result queries, citation counts, per-gateway adoption.
- **P1-5. Capture-from-chat**: lightweight MCP tool (`propose_knowledge`) letting an engineer say "save this as a lesson learned" in any assistant; lands in the curator review queue, never directly in the verified graph.
- **P1-6. Network-drive ingestion agent** for firms with on-prem file servers.
- **P1-7. SOC 2 Type II report** delivered.
- **P1-8. Drawing intelligence, level 2**: schedule/table extraction from drawing sheets, detail-callout detection with region-level bounding (a `DesignDetail` links to the exact region on a sheet, not just the sheet), and sheet cross-reference resolution ("see 5/A-501" becomes a graph edge).

### P2 — Future Considerations (design for, don't build)

- **P2-1. BIM/IFC awareness**: extract entities from Revit/IFC models (buildingSMART data dictionary alignment). Keep the ontology compatible with IFC class names now so this doesn't force a remodel.
- **P2-2. GovCloud / GCC High deployment** for federal-work firms (note: Copilot federated connectors unavailable in DoD clouds — synced connector becomes the only Copilot path there).
- **P2-3. Opt-in cross-firm anonymized insights** (e.g., "products with industry-wide failure reports"). Requires legal framework; tenant isolation architecture must not preclude a separate aggregation pipeline.
- **P2-4. Write-back integrations** (create an RFI in Procore from chat). Keep MCP tool surface read-only in v1; reserve tool-name space for actions.
- **P2-5. Email/Teams mining** for undocumented decisions. High value, high privacy sensitivity — needs its own consent model.
- **P2-6. Full drawing-content understanding**: semantic interpretation of linework, annotations, and symbols on sheets — beyond the title blocks, tables, and callout regions covered by P0-2a and P1-8. Pairs with P2-1; keep the parsed-region data model forward-compatible.

## Success Metrics

**Leading (evaluate at 30/90 days post-rollout per tenant)**
| Metric | Target | Stretch | Measurement |
|---|---|---|---|
| Technical-staff monthly active queriers | 60% by day 90 | 75% | Gateway audit logs, per tenant |
| Grounded-answer citation correctness | ≥ 85% | ≥ 92% | Monthly 50-question eval set per tenant, human-scored |
| Zero-result query rate | < 25% by day 90 | < 15% | `no_results` events / total queries |
| Time-to-precedent (task study) | < 5 min median | < 2 min | Quarterly task-based study with 2 design partners |
| Knowledge items added or verified / month / tenant | ≥ 50 by month 6 | ≥ 150 | Curation event log |
| Curation throughput (median time per review-queue item) | < 2 min | < 1 min | Workbench telemetry |
| Citation click-through to workspace app | ≥ 15% of cited answers | ≥ 25% | Deep-link telemetry by gateway |
| Admin deployment time (all 3 gateways) | < 1 day | < 2 hours | Onboarding telemetry + CSM report |

**Lagging (evaluate quarterly)**
- Net revenue retention ≥ 110%; logo retention ≥ 90% at first renewal
- ≥ 2 of 3 gateways actively used per tenant (validates the multi-gateway thesis; if everyone uses only Copilot, the strategy needs revisiting)
- Customer-reported rework avoidance (case-study evidence; target 3 documented cases by GA+2 quarters)

## Key Risks

1. **Garbage in, confident garbage out.** If firms bulk-ingest without curation — or if PDF parsing silently mangles drawings and scans — the graph grounds answers in wrong or outdated content. Mitigation: review-status model (P0-1), curator queue (P0-2), per-class parsing thresholds and OCR confidence gating (P0-2a), staleness detection (P1-3), and onboarding that starts with a curated seed corpus, not a drive dump.
2. **Platform dependency.** All three host platforms are evolving their connector programs rapidly; spec changes (especially OpenAI's connector requirements) can break a gateway. Mitigation: MCP-first architecture concentrates the surface area; contract tests against each platform run in CI; one engineer owns platform-watch.
3. **Liability framing.** A grounded-but-wrong answer on a structural question is worse than no answer. Mitigation: provenance everywhere (P0-8), EOR-responsibility framing reviewed by counsel (Open Question 2), and explicitly *not* claiming design validation (Non-Goals).
4. **Permission mapping errors** are the one-strike trust killer for IT buyers. Mitigation: red-team acceptance suite in P0-7 treated as release-blocking.
5. **Platform players own the data and the workflow.** Autodesk ("design & make intelligence," Autodesk Assistant) and Procore (Procore AI / Agent Builder) are adding cross-project knowledge reuse on top of the data they already hold, and could out-feature us on *their* content or throttle our ingestion. Mitigation: compete on the cross-vendor graph that spans their competitors (P1-2 neutrality), vertical parsing depth they won't replicate for rivals' file formats, and provenance/EOR rigor; treat ingestion connectors as a contractual/partnership risk to monitor, and never let our value depend on any single source remaining open.
6. **Differentiation drift.** "Ground your assistant in firm knowledge" and "connect multiple assistants" are commoditizing (Glean, Work IQ). If we position or build toward those, we compete head-on with better-funded horizontal players. Mitigation: hold the line on the vertical wedge (P0-2a parsing, P0-8 provenance, P1-2 cross-vendor) as the headline; treat gateway breadth as distribution. The lagging metric "≥ 2 of 3 gateways actively used" is a check on *adoption breadth*, not a claim that breadth is the moat.

## Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| 1 | Graph store selection (native graph DB vs. relational + graph layer) and retrieval architecture (GraphRAG-style traversal vs. hybrid vector + filters) — needs a spike with realistic AEC corpora | Engineering | Yes — before build |
| 2 | Liability language and answer-footer disclaimers; does grounding firm knowledge in third-party LLMs affect professional-liability insurance posture? | Legal + insurance advisor | Yes — before design-partner pilots |
| 3 | Can standard/code entities include excerpt text, or references only? (ICC, ASCE, ACI license terms) | Legal | Yes — affects P0-1 scope |
| 4 | OpenAI connector program: confirm current admin-distribution mechanics for Business/Enterprise workspaces and any review/approval process | Product (platform watch) | Yes — affects P0-5 rollout docs |
| 5 | Pricing model: per-seat vs. per-tenant + usage; does gateway count affect packaging? | Product/GTM | No |
| 6 | Design partners: which 2–3 firms (target: 1 structural, 1 MEP, 1 multi-discipline, 100–500 staff) | GTM | No — but needed by Phase 2 |
| 7 | Entity-extraction model choice and human-review thresholds (auto-accept confidence cutoff?) | Engineering + Data | No — resolve during Phase 1 |
| 8 | PDF parsing stack — buy vs. build: evaluate document-understanding services vs. open-source parsers against the design-partner corpus (large-format scans, Bluebeam-generated sets, spec books); set the per-class quality thresholds that gate P0-2a | Engineering | Yes — Phase 1 spike, before pipeline build |

## Timeline Considerations

No hard external deadline; phasing is driven by dependency order — the graph must exist before gateways, and gateways before connector-program approvals (which have unpredictable review queues, so they start early).

- **Phase 1 (Months 0–3): Graph core + ingestion + workspace app foundation.** P0-1, P0-2, P0-2a (starting with the parsing spike, Open Question 8), and the app's curation half (P0-9: curation workbench, entity pages, capture forms, search, ingestion wizard) — curators need the app from day one to seed the graph. Onboard 2 design partners' corpora, which double as the parsing test corpus. Resolve Open Questions 1–3 and 8.
- **Phase 2 (Months 2–5, overlapping): MCP gateway + Claude + graph explorer.** P0-3, P0-4, P0-7, P0-8, plus the app's exploration half (P0-9: interactive graph explorer, citation deep links) — landing alongside the first gateway so cited answers have somewhere to click through to. Claude first because remote-MCP connector setup is the most direct path to end-to-end validation.
- **Phase 3 (Months 4–6): ChatGPT + Copilot.** P0-5, P0-6. Start platform registration/review processes at the *beginning* of this phase. Declarative-agent packaging and admin docs.
- **GA gate:** all P0 acceptance criteria green (including the full P0-9 app), red-team permission suite passing, 2 design partners hitting day-30 adoption targets.
- **Post-GA:** P1-1 (Graph synced connector) and P1-2 (Procore/ACC) are the first two fast-follows, in that order, unless design-partner demand says otherwise.

---

*Sources for platform capabilities: Microsoft 365 Copilot connectors overview (synced vs. MCP-based federated connectors), Build plugins from an MCP server for Microsoft 365 Copilot (declarative agents + Agents Toolkit), Microsoft Learn, retrieved 2026-06-09. ChatGPT and Claude connector capabilities per OpenAI/Anthropic MCP connector documentation.*

*Competitive Landscape sources (retrieved 2026-06-16): Microsoft Work IQ overview and Work IQ APIs GA (Microsoft Learn / M365 Blog); Glean MCP Gateway, enterprise graph, and ~$200M ARR (glean.com, Futurum Group); Knowledge Architecture Synthesis (knowledge-architecture.com); Skema.AI BIM knowledge-reuse engine; Trunk Tools and Autodesk "design & make intelligence" (BuiltWorlds, Autodesk newsroom); Procore AI / Agent Builder (Procore press); Trimble–Document Crunch acquisition (Trimble newsroom); AEC software market size (Verified Market Reports, AEC Hub). The 15–30% "search time" figure is contested (traces to early-2000s IDC studies).*
