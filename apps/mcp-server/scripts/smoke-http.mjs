#!/usr/bin/env node
/**
 * End-to-end smoke test for the remote HTTP gateway (PRD P0-3). Spawns the
 * built server with EKG_TRANSPORT=http, connects with the real MCP client over
 * Streamable HTTP, and proves the gateway is genuinely multi-user: identity
 * comes from a per-request bearer JWT, and ACL trimming + tenant isolation
 * (PRD P0-7) follow the token, not a fixed dev caller.
 *
 * The tokens are signed here with an independent HS256 implementation — a
 * stand-in for the identity provider — so this also cross-checks the server's
 * verifier against a signer it does not share code with.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = 'smoke-secret';
const PORT = process.env.SMOKE_PORT ?? '8799';
const base = `http://localhost:${PORT}`;

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function sign(claims, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// A façade engineer, the firm's outside counsel, and a user from another firm.
const engineerTok = sign({ tid: 'demo-firm', sub: 'user:priya', groups: ['group:engineering'] }, SECRET);
const legalTok = sign({ tid: 'demo-firm', sub: 'user:counsel', groups: ['group:legal'] }, SECRET);
const otherTenantTok = sign({ tid: 'other-firm', sub: 'user:rival', groups: ['group:engineering'] }, SECRET);

function assert(cond, label) {
  if (!cond) throw new Error(`smoke-http failed: ${label}`);
  console.log(`ok - ${label}`);
}

function body(result) {
  return JSON.parse(result.content[0].text);
}

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'smoke-http', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready on /healthz');
}

// Audit to a temp file so we can assert the per-request, per-principal P0-7
// trail (cleaned up on exit).
const auditPath = join(tmpdir(), `ekg-audit-smoke-http-${process.pid}.jsonl`);

// A managed upload root for the ingest_document confinement checks (P0
// security): an in-root file may be ingested; a path outside it is refused so a
// network caller cannot read arbitrary host files.
const workDir = mkdtempSync(join(tmpdir(), 'ekg-ingest-'));
const uploadRoot = join(workDir, 'uploads');
mkdirSync(uploadRoot);
const insideFile = join(uploadRoot, 'curtain-wall-lesson.txt');
writeFileSync(insideFile, 'Lesson: seal curtain wall firestop gaps per spec section 07 84 00 at Riverside.');
const insidePublicFile = join(uploadRoot, 'public-standard-note.txt');
writeFileSync(insidePublicFile, 'General note: all firestop assemblies follow ASTM E814.');
const outsideFile = join(workDir, 'host-secret.txt');
writeFileSync(outsideFile, 'SHOULD NOT BE INGESTIBLE OVER HTTP');

function cleanup() {
  rmSync(auditPath, { force: true });
  rmSync(workDir, { recursive: true, force: true });
}

const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
  env: {
    ...process.env,
    EKG_TRANSPORT: 'http',
    EKG_JWT_SECRET: SECRET,
    EKG_PORT: PORT,
    EKG_DB_PATH: '',
    EKG_AUDIT_LOG: auditPath,
    EKG_UPLOAD_ROOT: uploadRoot,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const clients = [];
try {
  await waitReady();
  assert(true, 'http gateway is listening (/healthz)');

  // --- Auth gate: no token and bad token are rejected before any handler ---
  const noAuth = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }),
  });
  assert(noAuth.status === 401, 'unauthenticated request rejected (401)');

  const badAuth = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' },
    body: '{}',
  });
  assert(badAuth.status === 401, 'invalid token rejected (401)');

  // --- Engineer: normal retrieval works, but the legal memo is ACL-trimmed ---
  const engineer = await connect(engineerTok);
  clients.push(engineer);
  const toolNames = (await engineer.listTools()).tools.map((t) => t.name).sort();
  assert(
    ['fetch', 'search', 'traverse'].every((n) => toolNames.includes(n)),
    `tools served over http (${toolNames.join(', ')})`,
  );

  const engSearch = body(await engineer.callTool({ name: 'search', arguments: { query: 'curtain wall firestop' } }));
  assert(engSearch.results?.length > 0, 'http search returns seeded results');
  assert(engSearch.results[0].provenance?.reviewStatus, 'http results carry provenance (P0-8)');

  const engMemo = body(await engineer.callTool({ name: 'fetch', arguments: { id: 'document:claims-memo-riverside' } }));
  assert(engMemo.error === 'not_found', 'engineer is ACL-trimmed from the legal memo');
  const engPrivileged = body(await engineer.callTool({ name: 'search', arguments: { query: 'privileged legal memo claim' } }));
  assert(
    !(engPrivileged.results ?? []).some((r) => r.id === 'document:claims-memo-riverside'),
    'legal memo never appears in engineer search results',
  );

  // --- Richer P0-3 tools work over http too, scoped to the caller ---
  const engExperts = body(await engineer.callTool({ name: 'find_experts', arguments: { query: 'curtain wall firestop' } }));
  assert(
    engExperts.experts?.some((e) => e.id === 'person:james-okafor'),
    'find_experts works over http',
  );
  const engCtx = body(await engineer.callTool({ name: 'get_project_context', arguments: { projectId: 'project:riverside' } }));
  assert(engCtx.project?.id === 'project:riverside', 'get_project_context works over http');

  // --- Legal counsel: SAME server, different token → the memo is visible ---
  const legal = await connect(legalTok);
  clients.push(legal);
  const legalMemo = body(await legal.callTool({ name: 'fetch', arguments: { id: 'document:claims-memo-riverside' } }));
  assert(
    legalMemo.id === 'document:claims-memo-riverside' && legalMemo.title,
    'legal counsel CAN fetch the legal memo — ACL trimming varies by token',
  );
  const legalPrivileged = body(await legal.callTool({ name: 'search', arguments: { query: 'privileged legal memo claim' } }));
  assert(
    (legalPrivileged.results ?? []).some((r) => r.id === 'document:claims-memo-riverside'),
    'legal memo appears in legal counsel search results',
  );

  // --- Tenant isolation: a token for another firm retrieves nothing (P0-7) ---
  const other = await connect(otherTenantTok);
  clients.push(other);
  const otherSearch = body(await other.callTool({ name: 'search', arguments: { query: 'curtain wall firestop' } }));
  assert(otherSearch.no_results === true, 'cross-tenant token retrieves nothing (tenant isolation)');

  // --- ingest_document: path confinement + default-restricted ACL (P0 security) ---
  // A file inside the configured upload root ingests as an unverified candidate.
  const ingOk = body(await engineer.callTool({ name: 'ingest_document', arguments: { path: insideFile } }));
  assert(ingOk.status === 'queued_unverified' && ingOk.id, 'in-root file ingests as an unverified candidate');

  // The uploader can read it back...
  const ownerFetch = body(await engineer.callTool({ name: 'fetch', arguments: { id: ingOk.id } }));
  assert(ownerFetch.id === ingOk.id, 'uploader can fetch their own ingested document');

  // ...but another principal in the SAME tenant cannot — it is NOT tenant-public
  // by default (the headline P0 fix: chat-ingested docs are no longer world-readable).
  const legalSeesIngest = body(await legal.callTool({ name: 'fetch', arguments: { id: ingOk.id } }));
  assert(
    legalSeesIngest.error === 'not_found',
    'chat-ingested doc is NOT readable by other tenant principals by default (no default-public ACL)',
  );

  // A path OUTSIDE the upload root is refused — no arbitrary host file read (LFI).
  const ingOutside = body(await engineer.callTool({ name: 'ingest_document', arguments: { path: outsideFile } }));
  assert(ingOutside.error === 'path_not_allowed', 'path outside the upload root is refused (LFI blocked)');

  // ...including traversal that climbs out of the root.
  const ingTraversal = body(
    await engineer.callTool({ name: 'ingest_document', arguments: { path: join(uploadRoot, '..', 'host-secret.txt') } }),
  );
  assert(ingTraversal.error === 'path_not_allowed', 'traversal out of the upload root is refused (LFI blocked)');

  // Explicit visibility:'public' opts back in to tenant-wide reads.
  const ingPublic = body(
    await engineer.callTool({ name: 'ingest_document', arguments: { path: insidePublicFile, visibility: 'public' } }),
  );
  const legalSeesPublic = body(await legal.callTool({ name: 'fetch', arguments: { id: ingPublic.id } }));
  assert(legalSeesPublic.id === ingPublic.id, "visibility:'public' makes the doc readable tenant-wide");

  // --- Audit trail (PRD P0-7): events are attributed to the calling token ---
  // Close clients first so every request's synchronous audit write has landed.
  for (const c of clients) await c.close().catch(() => {});
  const auditEvents = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    auditEvents.length > 0 && auditEvents.every((e) => e.transport === 'http'),
    'http tool calls are audited as transport=http (P0-7)',
  );
  // The engineer's blocked attempt on the legal memo is recorded under HER
  // principal — the audit trail captures who tried, not just who succeeded.
  assert(
    auditEvents.some(
      (e) => e.tool === 'fetch' && e.principal === 'user:priya' && e.outcome === 'error',
    ),
    'engineer’s ACL-blocked fetch is audited under user:priya',
  );
  // Counsel's successful read of the memo is recorded under HIS principal.
  assert(
    auditEvents.some(
      (e) =>
        e.tool === 'fetch' &&
        e.principal === 'user:counsel' &&
        (e.resultIds ?? []).includes('document:claims-memo-riverside'),
    ),
    'counsel’s successful memo fetch is audited under user:counsel with the item id',
  );
  assert(
    auditEvents.some((e) => e.tool === 'find_experts' && e.tenantId === 'demo-firm'),
    'richer tools are inside the audit boundary over http',
  );

  console.log('smoke-http: all checks passed');
  cleanup();
  child.kill();
  process.exit(0);
} catch (err) {
  console.error(String(err));
  for (const c of clients) await c.close().catch(() => {});
  cleanup();
  child.kill();
  process.exit(1);
}
