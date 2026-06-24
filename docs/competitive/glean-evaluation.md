# Competitive Evaluation: EKG vs. Glean

| | |
|---|---|
| **Subject** | Glean (horizontal Work AI platform) vs. Engineering Knowledge Graph (EKG) |
| **Author** | Robert Denison |
| **Date** | 2026-06-16 |
| **Method** | Direct read of Glean's own comparison pages (glean.com/compare and per-competitor pages) + their published enterprise-context evaluation, mapped against EKG's PRD and shipped architecture |
| **Bottom line** | Glean is the closest competitor to EKG's thesis and has published its attack playbook. Its central architectural critique — "persistent index beats federated MCP" — **does not land on EKG**, because EKG is a persistent curated index *served over* MCP, not query-time federation. EKG cannot and should not contest Glean on horizontal breadth; it wins only on the AEC vertical wedge. Treat Glean as a coexistence/complement case, not a head-to-head. |

---

## 1. Why Glean is the comparison that matters

Of every competitor in the field, Glean overlaps most with EKG's stated thesis: a **permissions-aware enterprise knowledge graph** that **grounds the AI assistants a company already uses** (Glean's MCP Gateway grounds ChatGPT/Claude/Gemini). Glean is the category leader (~$200M ARR, doubled YoY) and — usefully — it publishes detailed comparison pages against Microsoft 365 Copilot, ChatGPT Enterprise, and Claude Enterprise. Those pages are, in effect, a free map of the dimensions Glean believes win enterprise AI deals. We can evaluate EKG against that same map.

The strategic point: **EKG does not lose to Glean on the vertical wedge, and cannot beat Glean on breadth.** The only wrong move is to position EKG on the axes Glean owns.

## 2. How Glean competes — the published playbook

Across its comparison pages, Glean differentiates on a consistent set of dimensions:

| # | Dimension | Glean's claim (verbatim/near-verbatim) |
|---|---|---|
| 1 | **Connector breadth & depth** | "275+ enterprise apps with turnkey connectors"; indexes "content, metadata, identities, and activity signals"; structured-data retrieval from Databricks, Snowflake, BigQuery, Salesforce, Workday |
| 2 | **Knowledge graph & personalization** | Enterprise Graph mapping "60+ signals across people, content, and relationships"; disambiguates jargon/acronyms; Personal Graph personalizes by role/team/collaboration |
| 3 | **Permissions enforcement** | All connectors "automatically enforce source-system permissions" at object/record level, nested groups, time-based, near-real-time, least-privilege |
| 4 | **Persistent index vs. federated retrieval** | A "fully managed persistent index feeding [an] enterprise knowledge graph" beats "federated retrieval without a persistent enterprise index" on both quality and token cost |
| 5 | **Model choice / openness** | "35+ models" (GPT-5.x, Claude Sonnet 4.6, Gemini, Llama…), mix by use case, no vendor lock-in, day-0 new-model support |
| 6 | **Deployment & hosting** | Single-tenant SaaS or customer VPC (AWS/GCP), data residency control |
| 7 | **Security & governance** | Glean Protect (PII/oversharing detection + remediation), centralized audit logs, HIPAA-suitable, agent sandbox, prompt-injection guardrails |
| 8 | **Agents & actions** | Horizontal agent platform, "100+ built-in actions," branching/looping orchestration |
| 9 | **Answer quality (proof)** | Blind preference evals: Glean preferred **1.9×** over ChatGPT and **1.6×** over Claude (correctness/completeness, ~280 queries); **2.5×** over off-the-shelf MCP with **23% fewer tokens** and a **73% win rate** on complex tasks |

### The one claim aimed at EKG's architecture

Glean's "vs. Claude Enterprise" page is built entirely on attacking **federated, MCP-at-query-time retrieval**:

> Claude "uses MCP connectors and federated retrieval without a persistent enterprise index," forcing "models to search across systems in real time with limited organizational understanding," which "increases token consumption."

EKG is an MCP server. On its face, this critique looks like it targets EKG directly. It does not — see §3.

## 3. Does Glean's architecture critique land on EKG? No.

Glean's attack is against systems that **federate at query time**: the model calls an MCP tool, the tool hits live source APIs, dumps raw content back, and the model reasons over unindexed material. That is wasteful and low-context.

**EKG is the opposite of that.** EKG:

- **Ingests, parses, chunks, embeds, and persists** content into a curated store (`store-sqlite`: entity + chunk-level FTS and embeddings, hybrid retrieval — ADR 0003, 0006).
- **Returns scored, chunked, provenance-tagged results** (title + deep link + page/sheet anchor), not raw file dumps — token-efficient by construction.
- **Serves only curated, review-status-gated knowledge** — the gateway exposes "exactly what curators approved."

So EKG sits on **Glean's preferred side** of the architecture: a persistent, curated index with a typed graph. MCP here is the **transport** that delivers that index to whatever assistant the firm uses — it is not the retrieval strategy. Glean's "federated MCP is worse" argument is an argument *for* EKG's design, not against it.

**Honest caveat.** Glean has invested heavily in retrieval science (per-enterprise semantic models, 60+ signals, a small ranking model "Waldo," blind preference evals). EKG's retrieval is comparatively simple (hybrid FTS + vector on SQLite). EKG should not claim to out-retrieve Glean on *general* enterprise content. EKG's compensating advantage is a **curated, well-parsed, provenance-rich, narrow corpus** where relevance is easier and citations are sheet-precise. The way to defend that claim is to adopt Glean's own discipline — blind preference evals — on the AEC domain (the PRD's 50-question monthly eval set is the right instrument; make it adversarial and comparative).

## 4. Dimension-by-dimension scorecard

Legend: ✅ meets/beats the bar for the target buyer · ➖ partial · ❌ not competitive · 🎯 **different game on purpose** (a non-goal, not a gap).

| Glean dimension | EKG status | Notes |
|---|---|---|
| Connector breadth (275+) | ❌ | EKG: SharePoint (P0) + Procore/ACC (P1) + network drives. Will never match horizontal breadth — and should not try. Wins on *which* sources (Procore/ACC, drawing repos) Glean under-serves. |
| Structured data (Salesforce/Workday/Snowflake) | 🎯 | Out of scope. EKG's "structured data" is the AEC graph itself. |
| Knowledge graph | ➖ / 🎯 | EKG has a **domain ontology** (Project, DesignDetail, SpecSection, LessonLearned, RFI, Expert…) with typed edges (`usedIn`, `supersedes`, `compliesWith`, `hadIssue`) and traversal/`find_experts`/`get_project_context`. Narrower than Glean's 60-signal generic graph, but **AEC-shaped** in ways Glean's is not. |
| Personalization (Personal Graph) | 🎯 | Not EKG's game. EKG personalizes via ACLs, not collaboration-signal ranking. |
| Permissions enforcement | ➖ | Architecturally present: ACL trimming, tenant isolation, per-request identity + audit on the remote transport. **Gap:** full OAuth 2.1 + Entra federation is still a verifier-only follow-on. Glean's object/record-level, nested-group, near-real-time enforcement is more mature — close this before enterprise IT review. |
| Persistent index vs. federated MCP | ✅ | EKG is a persistent curated index, not query-time federation (see §3). Turn this into explicit positioning. |
| Model choice (35+) | 🎯 | N/A by design — EKG is **not the chat surface** (non-goal). It rides whatever model the host assistant runs. "No model hub" is a consequence of the distribution bet, not a weakness. |
| Deployment/hosting (VPC, residency) | ❌→➖ | Multi-tenant SaaS planned; per-tenant encryption + SOC 2 on the roadmap. No customer-VPC story yet. Matters for large/regulated AEC firms; note as a roadmap gap. |
| Security & governance suite | ➖ | EKG: review-status model, audit log, red-team ACL suite (release-gating). **No** DLP/PII-detection product equivalent to Glean Protect. Fine for v1; name the gap. |
| Agents & actions | 🎯 | EKG is read-only in v1 by design (write-back is P2). Not competing on agent orchestration. |
| Answer-quality proof | ➖ | EKG has the eval *plan* (85% citation correctness target). Glean has published blind comparative evals. **Adopt Glean's method**; comparative proof is a sales asset. |
| Ubiquity (Slack/Teams/browser) | ✅ / 🎯 | EKG reaches users inside Claude/ChatGPT/Copilot via MCP — same "meet users where they are" idea, executed as gateways rather than first-party surfaces. |

## 5. Where EKG genuinely wins (the wedge Glean cannot reach)

These are the squares Glean's horizontal architecture structurally cannot occupy without becoming a different product:

1. **AEC-native document understanding.** Drawing sets parsed to sheet / title-block / region; spec books split by MasterFormat section; CAD-native vector parsing; OCR-confidence gating; **page/sheet-anchored citations**. Glean indexes a drawing set or spec book as an opaque file. This is the decisive differentiator and should be the headline of every Glean comparison.
2. **Provenance & EOR-liability rigor.** Review-status semantics (`verified`/`superseded`/`deprecated`), superseded/known-bad items flagged rather than silently served, and an explicit `no_results` state that forbids substituting generic LLM knowledge. Glean has citations and Glean Protect, but not *domain liability semantics*.
3. **Human-in-the-loop curation.** EKG's curation workbench gates what becomes "verified" knowledge. Glean auto-indexes everything. In a domain where a confidently wrong structural answer carries liability, **curation is a feature, not friction.**
4. **Cross-vendor source neutrality incl. Procore/ACC.** The richest lessons-learned source (RFIs, submittals, issues) lives in construction-management systems Glean under-prioritizes. Spanning M365 *and* Procore/ACC is a moat against both Glean and the platform walled gardens.
5. **Token-efficient, citation-first responses.** EKG returns ranked chunks with anchors, not raw documents — pre-empting the very "federated MCP wastes tokens" critique Glean levels at others.

## 6. Where EKG must NOT try to compete

Pushing onto any of these is a fight against a better-funded incumbent on its home turf: horizontal connector breadth, Personal-Graph personalization, structured-data computation, a 35-model hub, a full DLP/governance suite, or an agent-orchestration platform. Each is either a Glean strength or an EKG non-goal. The PRD already declares most as non-goals — keep them there.

## 7. The coexistence question (what if the firm already runs Glean or Copilot?)

This is the real go-to-market scenario, not a winner-take-all bake-off. A 200-person structural firm will not buy Glean's full platform *to get drawing-set Q&A* — and Glean cannot parse drawings anyway. So:

- **Position EKG as the AEC document-intelligence + provenance layer that plugs into whatever the firm already has.** EKG's MCP server can be registered in Glean's MCP Gateway, or its curated items fed to Glean/Copilot as a source. EKG supplies the sheet-anchored, provenance-rich AEC knowledge those generic layers cannot extract; they supply breadth and the chat surface.
- **The objection to rehearse:** "We already have Glean/Copilot." The answer is the same vertical wedge — *they index your files; we understand your drawings and specs and stand behind every citation.* Not a competing horizontal index.

## 8. Verdict & recommendations

**Verdict.** Glean validates the market and the architecture (persistent curated graph + grounding the assistants you use) — and, critically, its published critique of "federated MCP" lands on naive MCP tools, **not** on EKG. EKG's risk vs. Glean is not losing a feature war; it is **mis-positioning onto Glean's axes** and **under-investing in the retrieval/eval rigor** that makes the curated graph credibly better *within* AEC.

**Recommendations:**

1. **Reframe MCP as transport, not retrieval strategy** — in the PRD and all collateral. Explicitly state EKG is a persistent, curated, parsed index (Glean's preferred architecture), delivered over MCP. Pre-empt the "isn't this just federated MCP?" critique.
2. **Adopt Glean's eval discipline for AEC.** Turn the PRD's 50-question monthly eval into a **blind, comparative** eval (EKG-grounded answer vs. ungrounded assistant vs. Glean/Copilot if present). Comparative preference numbers are the single best sales asset against horizontal incumbents.
3. **Lead every comparison with parsing + provenance**, the two squares Glean cannot reach; never lead with "multi-gateway" or "ground your AI" (Glean owns both).
4. **Close the permissions/IdP gap.** Glean's object/record-level, near-real-time, nested-group enforcement is the IT-buyer bar. Finish OAuth 2.1 + Entra federation (currently a follow-on) before enterprise security reviews — it is the table-stakes EKG is closest to missing.
5. **Write the coexistence story explicitly** (PRD Non-Goals already says "complement, don't replace" for Work IQ — extend the same to Glean): EKG as the AEC layer that feeds Glean/Copilot, not a horizontal-search replacement.
6. **Name the honest roadmap gaps** (no VPC/residency story, no DLP equivalent, simpler retrieval science) so they are deliberate sequencing decisions, not surprises in a deal.

---

### Sources (retrieved 2026-06-16)

- Glean compare hub — https://www.glean.com/compare
- Glean vs Microsoft 365 Copilot — https://www.glean.com/compare/glean-vs-copilot
- Glean vs ChatGPT Enterprise — https://www.glean.com/glean-vs-chatgpt-enterprise
- Glean vs Claude Enterprise — https://www.glean.com/compare/glean-vs-claude-enterprise
- Glean enterprise-context evaluation (1.9×/1.6× preference) — https://www.glean.com/blog/enterprise-search-evaluation-2026
- Glean MCP Gateway — https://www.glean.com/blog/introducing-glean-mcp-gateway
- Glean ~$200M ARR / vs Copilot analysis — https://futurumgroup.com/insights/glean-doubles-arr-to-200m-can-its-knowledge-graph-beat-copilot/
