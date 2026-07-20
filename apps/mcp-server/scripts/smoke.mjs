#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built MCP server on stdio, performs the
 * MCP handshake, lists tools, and runs a search against the seeded demo
 * graph. Exits non-zero on any failure.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Audit to a temp file so we can assert the P0-7 trail was written (cleaned up
// on exit).
const auditPath = join(tmpdir(), `ekg-audit-smoke-${process.pid}.jsonl`);
// The samples folder doubles as the ingest root: path ingestion requires one
// on every transport, and relative paths resolve against it.
const samples = join(root, '../../services/ingestion/samples');
const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
  env: { ...process.env, EKG_AUDIT_LOG: auditPath, EKG_INGEST_ROOT: samples, EKG_UPLOAD_ROOT: undefined },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function assert(cond, label) {
  if (!cond) throw new Error(`smoke failed: ${label}`);
  console.log(`ok - ${label}`);
}

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  assert(init.serverInfo?.name === 'ekg-mcp', 'initialize handshake');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tools = await request(2, 'tools/list', {});
  const names = tools.tools.map((t) => t.name).sort();
  assert(
    ['fetch', 'find_experts', 'get_project_context', 'search', 'traverse'].every((n) =>
      names.includes(n),
    ),
    `tools registered (${names.join(', ')})`,
  );

  const search = await request(3, 'tools/call', {
    name: 'search',
    arguments: { query: 'curtain wall firestop' },
  });
  const payload = JSON.parse(search.content[0].text);
  assert(payload.results?.length > 0, 'search returns seeded results');
  assert(payload.results[0].provenance?.reviewStatus, 'results carry provenance (P0-8)');
  const superseded = payload.results.find((r) => r.id === 'detail:cw-firestop-01');
  assert(superseded?.warning, 'superseded result carries warning (P0-8)');

  const noHits = await request(4, 'tools/call', {
    name: 'search',
    arguments: { query: 'zzz-no-such-topic-zzz' },
  });
  const empty = JSON.parse(noHits.content[0].text);
  assert(empty.no_results === true && empty.guidance, 'explicit no_results state (P0-8)');
  assert(
    !empty.results?.length && /retry ONCE/.test(empty.guidance),
    'no_results guidance prompts one narrower retry before declaring absence',
  );

  // Passage citation (ADR 0006 / P0-2a): a spec hit resolves to the section,
  // not just the file, and the anchor survives serialization to the client.
  const deep = await request(30, 'tools/call', {
    name: 'search',
    arguments: { query: '25 percent compression mineral wool' },
  });
  const deepPayload = JSON.parse(deep.content[0].text);
  const specHit = deepPayload.results?.find((r) => r.id === 'spec:07-84-00');
  assert(specHit, 'deep-content query reaches the spec book through its passages');
  assert(
    /PART 2/.test(specHit.matchedSection ?? ''),
    'spec hit names the passage that answers it, not page 1 (P0-2a)',
  );
  assert(
    specHit.provenance?.anchor?.specSection === '07 84 00' &&
      specHit.provenance.anchor.page === 2,
    'passage anchor merges into the citation the client sees (ADR 0006)',
  );
  assert(
    /25 percent compression/.test(specHit.snippet ?? ''),
    'snippet quotes the matched passage, not the file-level summary',
  );

  // Relaxed pass (P0-8): concepts split across entities return partial hits
  // that name what matched AND what did not — never served as full answers.
  const split = await request(31, 'tools/call', {
    name: 'search',
    arguments: { query: 'curtain wall firestop riverside camber' },
  });
  const splitPayload = JSON.parse(split.content[0].text);
  const partial = splitPayload.results?.find((r) => r.partial);
  assert(partial, 'concepts split across entities yield partial hits, not a false no_results');
  assert(
    partial.partial.matchedConcepts?.length > 0 && partial.partial.missingConcepts?.includes('camber'),
    'partial hit discloses both matched and missing concepts (P0-8)',
  );

  const traverse = await request(5, 'tools/call', {
    name: 'traverse',
    arguments: { entityId: 'detail:cw-firestop-02', relationshipType: 'used-in' },
  });
  const graph = JSON.parse(traverse.content[0].text);
  assert(graph.neighbors?.[0]?.id === 'project:riverside', 'traverse follows relationships');

  // --- Richer P0-3 tools: find_experts + get_project_context ---
  const experts = await request(20, 'tools/call', {
    name: 'find_experts',
    arguments: { query: 'curtain wall firestop' },
  });
  const expertPayload = JSON.parse(experts.content[0].text);
  const okafor = expertPayload.experts?.find((e) => e.id === 'person:james-okafor');
  assert(okafor, 'find_experts surfaces the author of matching knowledge');
  assert(
    okafor.evidence?.some((ev) => ev.id === 'detail:cw-firestop-02'),
    'expert ships with the authored evidence that grounds the expertise (P0-8)',
  );

  const noExperts = await request(21, 'tools/call', {
    name: 'find_experts',
    arguments: { query: 'zzz-no-such-topic-zzz' },
  });
  const noExpertPayload = JSON.parse(noExperts.content[0].text);
  assert(
    noExpertPayload.no_results === true && noExpertPayload.guidance,
    'find_experts has an explicit no_results state (P0-8)',
  );

  const context = await request(22, 'tools/call', {
    name: 'get_project_context',
    arguments: { projectId: 'project:riverside' },
  });
  const ctx = JSON.parse(context.content[0].text);
  assert(ctx.project?.id === 'project:riverside', 'get_project_context resolves the project');
  assert(
    ctx.detailsAndDocuments?.some((d) => d.id === 'detail:cw-firestop-02'),
    'project context lists the details used on the project',
  );
  assert(
    ctx.specifications?.some((s) => s.id === 'spec:07-84-00'),
    'project context lists the applicable specifications',
  );
  assert(
    ctx.issuesAndLessons?.some((l) => l.id === 'lesson:firestop-mockup-failure'),
    'project context lists issues and lessons learned',
  );
  assert(
    ctx.team?.some((p) => p.id === 'person:james-okafor'),
    'project context names the people who worked on it (second degree)',
  );

  const byName = await request(23, 'tools/call', {
    name: 'get_project_context',
    arguments: { query: 'Riverside' },
  });
  const byNameCtx = JSON.parse(byName.content[0].text);
  assert(
    byNameCtx.project?.id === 'project:riverside',
    'get_project_context resolves a project by name',
  );

  // --- Gateway ingestion + client-model description flow (ADR 0005) ---
  // A bare relative filename resolves against the ingest root (the guide-06
  // tour's "add C-102 from the inbox" flow) — no cwd involved.
  const ingested = await request(6, 'tools/call', {
    name: 'ingest_document',
    arguments: { path: '07 92 00 - Joint Sealants Spec (excerpt).pdf' },
  });
  const spec = JSON.parse(ingested.content[0].text);
  assert(
    spec.status === 'queued_unverified',
    'ingest queues candidate as unverified (relative path resolved against the ingest root)',
  );
  assert(spec.parseStatus === 'extracted', 'ingest extracts the PDF text layer (ADR 0004)');

  const described = await request(7, 'tools/call', {
    name: 'save_description',
    arguments: {
      entityId: spec.id,
      description: 'Joint sealant spec excerpt covering silicone sealant and backer rod.',
      annotations: ['ASTM C920', 'fabricated-callout-zz9'],
    },
  });
  const report = JSON.parse(described.content[0].text);
  assert(report.grounded.includes('ASTM C920'), 'verbatim annotation grounds against text layer');
  assert(
    report.ungrounded.includes('fabricated-callout-zz9'),
    'fabricated annotation is flagged ungrounded (ADR 0005 honesty gate)',
  );

  const refetched = await request(8, 'tools/call', {
    name: 'fetch',
    arguments: { id: spec.id },
  });
  const stored = JSON.parse(refetched.content[0].text);
  assert(
    stored.metadata.provenance.reviewStatus === 'unverified',
    'described entity stays unverified until curated',
  );
  assert(
    stored.metadata.properties.descriptionUngrounded?.includes('fabricated-callout-zz9'),
    'ungrounded annotations stored separately for curator review',
  );
  // ADR 0006: fetch exposes the document's section index with anchors.
  assert(stored.metadata.sectionCount >= 1, 'fetch returns the document section index');
  assert(
    typeof stored.metadata.sections?.[0]?.anchor?.page === 'number',
    'sections carry a page anchor for citation (ADR 0006)',
  );

  // ADR 0006: a query for the document's body matches a passage and the
  // result cites the section it matched on.
  const chunkSearch = await request(10, 'tools/call', {
    name: 'search',
    arguments: { query: 'backer rod closed-cell polyethylene' },
  });
  const chunkPayload = JSON.parse(chunkSearch.content[0].text);
  const passageHit = chunkPayload.results?.find((r) => r.id === spec.id);
  assert(passageHit, 'chunk-level search finds the ingested spec by its body text');
  assert(
    passageHit.matchedSection && passageHit.provenance?.anchor?.page,
    'passage hit cites the page/section it matched (ADR 0006)',
  );

  // Pull one section in full by ordinal.
  const section = await request(11, 'tools/call', {
    name: 'fetch',
    arguments: { id: spec.id, section: 0 },
  });
  const sectionDoc = JSON.parse(section.content[0].text);
  assert(
    sectionDoc.section?.ordinal === 0 && sectionDoc.text.length > 0,
    'fetch returns a specific section in full',
  );

  const scan = await request(9, 'tools/call', {
    name: 'ingest_document',
    arguments: { path: join(samples, 'A-501 Curtain Wall Details (scanned).pdf') },
  });
  const scanStatus = JSON.parse(scan.content[0].text);
  assert(scanStatus.parseStatus === 'needs-ocr', 'scanned sheet flagged needs-ocr');
  const imageBlocks = scan.content.filter((c) => c.type === 'image');
  if (scanStatus.imagesAttached > 0) {
    assert(
      imageBlocks.length === scanStatus.imagesAttached,
      `sheet images attached for client-model description (${imageBlocks.length})`,
    );
  } else {
    console.log('ok - sheet images skipped (pdftoppm not installed on this host)');
  }

  // VLM fusion (ADR 0007): a drawing ingest surfaces deterministic vector
  // facts as ground truth for the describing model. Gated on poppler — the
  // facts ride with the rendered images.
  const drawing = await request(10, 'tools/call', {
    name: 'ingest_document',
    arguments: { path: join(samples, 'C-102 Drainage Plan (callouts).pdf'), describe: true },
  });
  const drawingStatus = JSON.parse(drawing.content[0].text);
  if (drawingStatus.imagesAttached > 0) {
    assert(
      drawingStatus.deterministicFacts?.sheetNumber === 'C-102',
      'drawing ingest fuses deterministic facts (sheet number C-102)',
    );
    const instr = drawing.content.find(
      (c) => c.type === 'text' && c.text.includes('DETERMINISTIC PARSE'),
    );
    assert(instr && /Sheet: C-102/.test(instr.text), 'describe instructions carry the ground-truth facts block');

    // ADR 0008: save_description grounds against the parser facts too — a
    // dimension quoted with extra words the text layer lacks is still
    // confirmed by the geometry parse.
    const desc = await request(11, 'tools/call', {
      name: 'save_description',
      arguments: {
        entityId: drawingStatus.id,
        description: 'Drainage plan with a wall section and a pipe schedule.',
        annotations: [`12'-6" at the wall section`, 'SECTION A-A', 'ZZ-fabricated-note'],
      },
    });
    const descReport = JSON.parse(desc.content[0].text);
    assert(
      descReport.parserConfirmed?.some((a) => a.includes(`12'-6"`)),
      'save_description confirms a dimension-with-words against the parser facts (ADR 0008)',
    );
    assert(
      descReport.ungrounded?.includes('ZZ-fabricated-note'),
      'fabricated annotation still flagged ungrounded under two-source grounding',
    );
  } else {
    console.log('ok - fusion + collaboration checks skipped (pdftoppm not installed on this host)');
  }

  // --- Capture-from-chat (PRD P1-5): propose_knowledge → curation queue ---
  const proposed = await request(30, 'tools/call', {
    name: 'propose_knowledge',
    arguments: {
      title: 'Backer rod sizing at wide joints',
      type: 'lesson-learned',
      summary: 'Backer rod one size up from joint width prevented sealant slump on wide joints.',
      tags: ['sealants', 'Joint Design'],
      projectId: 'project:riverside',
      author: 'Priya Sharma',
    },
  });
  const proposal = JSON.parse(proposed.content[0].text);
  assert(proposal.status === 'queued_unverified', 'propose_knowledge queues candidate as unverified');
  assert(proposal.linkedProject?.id === 'project:riverside', 'proposal links to the named project');
  assert(
    proposal.tags?.includes('joint-design'),
    'proposal tags are normalized like the capture form',
  );

  const proposalFetched = await request(31, 'tools/call', {
    name: 'fetch',
    arguments: { id: proposal.id },
  });
  const proposalDoc = JSON.parse(proposalFetched.content[0].text);
  assert(
    proposalDoc.metadata.provenance.reviewStatus === 'unverified',
    'proposed knowledge stays unverified until curated (P1-5)',
  );
  assert(
    proposalDoc.metadata.related?.some((r) => r.relationship === 'used-in' && r.id === 'project:riverside'),
    'proposed knowledge carries a used-in edge to the project',
  );

  const badProposal = await request(32, 'tools/call', {
    name: 'propose_knowledge',
    arguments: {
      title: 'Dangling link test',
      type: 'lesson-learned',
      summary: 'Should fail whole, leaving no orphan candidate.',
      projectId: 'project:no-such-project',
    },
  });
  const badResult = JSON.parse(badProposal.content[0].text);
  assert(badResult.error === 'not_found', 'bad project id fails the proposal instead of orphaning it');

  // Unknown arguments must be REJECTED, not silently stripped. A plain z.object
  // drops unrecognized keys, so calling with `project`/`attribution` instead of
  // `projectId`/`author` used to return queued_unverified and write an
  // unlinked, unattributed candidate — the model believes it supplied a project
  // and an author, and the curator never learns otherwise.
  const wrongNames = await request(33, 'tools/call', {
    name: 'propose_knowledge',
    arguments: {
      title: 'Wrong param names',
      type: 'lesson-learned',
      summary: 'Must not be silently accepted with dropped arguments.',
      project: 'project:riverside',
      attribution: 'James Okafor',
    },
  });
  // Surfaced as an isError tool result (not a JSON-RPC error), so the model
  // sees the message and can retry with the right names.
  assert(wrongNames.isError === true, 'unknown arguments are rejected, not silently dropped');
  const strictText = wrongNames.content[0].text;
  assert(
    /unrecognized_keys/.test(strictText) &&
      /project/.test(strictText) &&
      /attribution/.test(strictText),
    'the rejection names the offending keys so the model can correct them',
  );

  // A relative path resolves against the ingest root, not the gateway cwd —
  // and a miss must say so, naming the root, so the caller can self-correct
  // (the guide-06 tour's `EKG-Inbox/…` prefix mistake).
  const relIngest = await request(34, 'tools/call', {
    name: 'ingest_document',
    arguments: { path: 'EKG-Inbox/no-such-file.pdf' },
  });
  const relResult = JSON.parse(relIngest.content[0].text);
  assert(relResult.error === 'not_found', 'a missing relative path still fails');
  assert(
    /ingest root/i.test(relResult.detail ?? '') && relResult.ingestRoot === realpathSync(samples),
    'not_found explains that relative paths resolve against the ingest root, and names it (stdio)',
  );

  // A nonexistent path OUTSIDE the root answers path_not_allowed exactly like
  // an existing one — the error split must not hand a caller a host-filesystem
  // existence oracle.
  const outsideMiss = await request(35, 'tools/call', {
    name: 'ingest_document',
    arguments: { path: '/definitely/not/under/the/root/file.pdf' },
  });
  const outsideMissResult = JSON.parse(outsideMiss.content[0].text);
  assert(
    outsideMissResult.error === 'path_not_allowed',
    'a nonexistent path outside the root is refused, not reported missing (no existence oracle)',
  );

  // --- Audit trail (PRD P0-7): every tool call left an immutable record ---
  // Audit writes are synchronous on the server before each response returns, so
  // by now the file holds an event for every call above.
  const auditEvents = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(auditEvents.length > 0, 'audit log captured tool calls (P0-7)');
  assert(
    auditEvents.every(
      (e) =>
        e.tenantId === 'demo-firm' &&
        e.principal === 'user:dev' &&
        e.transport === 'stdio' &&
        typeof e.ts === 'string',
    ),
    'audit events carry caller identity, transport, and timestamp (P0-7)',
  );
  const expertsAudit = auditEvents.find((e) => e.tool === 'find_experts' && e.outcome === 'ok');
  assert(
    expertsAudit?.resultIds?.includes('person:james-okafor'),
    'audit records which items a call surfaced (find_experts → the expert)',
  );
  assert(
    auditEvents.some((e) => e.tool === 'search' && e.outcome === 'no_results'),
    'audit distinguishes no_results outcomes',
  );
  assert(
    auditEvents.some((e) => e.tool === 'get_project_context'),
    'every tool is wrapped by the audit boundary',
  );

  // --- No ingest root: path ingest fails CLOSED, stdio included -------------
  // The old "unset = unconfined" default turned one missing env var in a stray
  // .mcp.json into silent unconfined ingest (guide 06's shadowing trap — hit
  // twice in real sessions). A server with no root must refuse even a readable
  // file, and say which variable to set.
  const bareAudit = join(tmpdir(), `ekg-audit-smoke-bare-${process.pid}.jsonl`);
  const bare = spawn(process.execPath, [join(root, 'dist/index.js')], {
    env: {
      ...process.env,
      EKG_INGEST_ROOT: undefined,
      EKG_UPLOAD_ROOT: undefined,
      EKG_AUDIT_LOG: bareAudit,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const barePending = new Map();
    let bareBuffer = '';
    bare.stdout.on('data', (chunk) => {
      bareBuffer += chunk.toString();
      let nl;
      while ((nl = bareBuffer.indexOf('\n')) >= 0) {
        const line = bareBuffer.slice(0, nl).trim();
        bareBuffer = bareBuffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && barePending.has(msg.id)) {
          barePending.get(msg.id)(msg);
          barePending.delete(msg.id);
        }
      }
    });
    const bareRequest = (id, method, params) =>
      new Promise((res, rej) => {
        const timer = setTimeout(
          () => rej(new Error(`timeout waiting for ${method} (no-root server)`)),
          10_000,
        );
        barePending.set(id, (msg) => {
          clearTimeout(timer);
          msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res(msg.result);
        });
        bare.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    await bareRequest(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke-bare', version: '0.0.0' },
    });
    bare.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const noRoot = await bareRequest(2, 'tools/call', {
      name: 'ingest_document',
      arguments: { path: join(samples, '07 92 00 - Joint Sealants Spec (excerpt).pdf') },
    });
    const noRootResult = JSON.parse(noRoot.content[0].text);
    assert(
      noRootResult.error === 'ingest_root_not_configured',
      'without an ingest root, path ingest fails closed on stdio (no unconfined default)',
    );
    assert(
      /EKG_INGEST_ROOT/.test(noRootResult.detail ?? ''),
      'the refusal names the variable to set',
    );
  } finally {
    bare.kill();
    rmSync(bareAudit, { force: true });
  }

  console.log('smoke: all checks passed');
  rmSync(auditPath, { force: true });
  child.kill();
  process.exit(0);
} catch (err) {
  console.error(String(err));
  rmSync(auditPath, { force: true });
  child.kill();
  process.exit(1);
}
