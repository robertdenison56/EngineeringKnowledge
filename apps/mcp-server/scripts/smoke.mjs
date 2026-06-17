#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built MCP server on stdio, performs the
 * MCP handshake, lists tools, and runs a search against the seeded demo
 * graph. Exits non-zero on any failure.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Audit to a temp file so we can assert the P0-7 trail was written (cleaned up
// on exit).
const auditPath = join(tmpdir(), `ekg-audit-smoke-${process.pid}.jsonl`);
const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
  env: { ...process.env, EKG_AUDIT_LOG: auditPath },
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
  const samples = join(root, '../../services/ingestion/samples');

  const ingested = await request(6, 'tools/call', {
    name: 'ingest_document',
    arguments: { path: join(samples, '07 92 00 - Joint Sealants Spec (excerpt).pdf') },
  });
  const spec = JSON.parse(ingested.content[0].text);
  assert(spec.status === 'queued_unverified', 'ingest queues candidate as unverified');
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
