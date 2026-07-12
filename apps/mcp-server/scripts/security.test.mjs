#!/usr/bin/env node
/**
 * GATEWAY SECURITY REGRESSION suite (PRD P0-3 / P0-7 and the P0 hardening pass).
 *
 * This is the adversarial complement to smoke-http.mjs: it is not a happy-path
 * smoke test, it exists to PROVE the multi-tenant boundary stays shut under
 * attack. Each block locks down one of the security properties that the recent
 * gateway change touched:
 *
 *   (a) EVERY read tool (search, fetch, traverse, find_experts,
 *       get_project_context) is ACL-trimmed identically — an engineer token can
 *       never reach the legal memo through ANY of them; a legal token can.
 *   (b) Cross-tenant isolation — a token for another firm retrieves nothing
 *       from every tool.
 *   (c) The arbitrary-file-read (LFI) fix — a file inside EKG_UPLOAD_ROOT
 *       ingests; a path outside it, and a `..` traversal out of it, are refused.
 *   (d) Default-restricted ingest ACL — a doc ingested by principal A (no
 *       visibility arg) is NOT readable by principal B in the same tenant;
 *       visibility:'public' makes it readable.
 *   (e) JWT hardening — forged signature, alg:"none", tampered payload (valid
 *       old sig), expired exp, and a missing bearer are each a 401 at /mcp.
 *
 * Harness mirrors smoke-http.mjs: spawn dist/index.js with EKG_TRANSPORT=http on
 * a unique port, EKG_JWT_SECRET set, EKG_DB_PATH='' (seeded in-memory), and
 * EKG_UPLOAD_ROOT pointing at a fresh temp dir holding a sample .txt. Tools are
 * driven with the real MCP client over Streamable HTTP; the JWT edge cases use
 * raw fetch with hand-crafted tokens. The HS256 signer here is independent of
 * the server's verifier (a stand-in identity provider), matching smoke-http.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = 'security-suite-secret';
const PORT = process.env.SECURITY_PORT ?? '8811';
const base = `http://localhost:${PORT}`;

const MEMO_ID = 'document:claims-memo-riverside'; // ACL: group:legal only.
const PROJECT_ID = 'project:riverside'; // public, used for a control read.

let passed = 0;
function assert(cond, label) {
  if (!cond) throw new Error(`security.test failed: ${label}`);
  passed += 1;
  console.log(`ok - ${label}`);
}

// --- Independent HS256 signer (a stand-in identity provider) ---------------
function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function sign(claims, secret = SECRET) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// Three identities: a façade engineer, the firm's outside counsel, and a user
// from a wholly different firm.
const engineerTok = sign({ tid: 'demo-firm', sub: 'user:priya', groups: ['group:engineering'] });
const legalTok = sign({ tid: 'demo-firm', sub: 'user:counsel', groups: ['group:legal'] });
const otherTenantTok = sign({ tid: 'other-firm', sub: 'user:rival', groups: ['group:engineering'] });
// A second principal in the SAME tenant — "principal B" for the
// default-restricted ingest ACL check (d). The default ingest ACL grants the
// uploader's OWN principals (sub + groups), so to prove the doc is genuinely
// restricted (and not just tenant-public) B must share NO principal with A:
// a distinct sub AND a distinct group from the engineer (user:priya /
// group:engineering).
const engineerBTok = sign({ tid: 'demo-firm', sub: 'user:dana', groups: ['group:structures'] });

function body(result) {
  return JSON.parse(result.content[0].text);
}

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'security-suite', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// Raw POST of a single JSON-RPC initialize with an arbitrary Authorization
// value — drives the JWT edge cases without the MCP client's own handshake.
async function rawInitialize(authHeader) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (authHeader !== undefined) headers.authorization = authHeader;
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }),
  });
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

// --- Managed upload root (for the LFI / ingest-ACL checks) ------------------
const workDir = mkdtempSync(join(tmpdir(), 'ekg-sec-'));
const uploadRoot = join(workDir, 'uploads');
mkdirSync(uploadRoot);
const insideFile = join(uploadRoot, 'restricted-note.txt');
writeFileSync(insideFile, 'Restricted lesson: firestop compression spec at Riverside, section 07 84 00.');
const insidePublicFile = join(uploadRoot, 'public-note.txt');
writeFileSync(insidePublicFile, 'Public note: all firestop assemblies follow ASTM E814.');
const outsideFile = join(workDir, 'host-secret.txt');
writeFileSync(outsideFile, 'SHOULD NOT BE INGESTIBLE OVER HTTP');

const auditPath = join(tmpdir(), `ekg-audit-security-${process.pid}.jsonl`);

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

  const engineer = await connect(engineerTok);
  clients.push(engineer);
  const legal = await connect(legalTok);
  clients.push(legal);
  const other = await connect(otherTenantTok);
  clients.push(other);
  const engineerB = await connect(engineerBTok);
  clients.push(engineerB);

  // =========================================================================
  // (a) EVERY read tool is ACL-trimmed identically.
  //     The engineer must NOT reach the legal memo via search, fetch,
  //     traverse, find_experts, or get_project_context; the legal token must.
  // =========================================================================

  // search — the memo never appears in the engineer's results, by content...
  const engMemoSearch = body(
    await engineer.callTool({ name: 'search', arguments: { query: 'privileged legal memo claim' } }),
  );
  assert(
    !(engMemoSearch.results ?? []).some((r) => r.id === MEMO_ID),
    'search: engineer never sees the legal memo in results',
  );
  // ...and by tag, in case a future ranker surfaces it differently.
  const engLegalTag = body(
    await engineer.callTool({ name: 'search', arguments: { query: 'memo', tags: ['legal'] } }),
  );
  assert(
    !(engLegalTag.results ?? []).some((r) => r.id === MEMO_ID),
    'search: engineer cannot reach the legal memo even with the legal tag filter',
  );
  // The legal token CAN find it — proves the trimming is per-token, not a
  // blanket hide that would make the assertion above vacuous.
  const legalMemoSearch = body(
    await legal.callTool({ name: 'search', arguments: { query: 'privileged legal memo claim' } }),
  );
  assert(
    (legalMemoSearch.results ?? []).some((r) => r.id === MEMO_ID),
    'search: legal counsel DOES see the legal memo (per-token trimming, not a blanket hide)',
  );

  // fetch — direct id read. Engineer is trimmed to not_found; legal gets it.
  const engMemoFetch = body(await engineer.callTool({ name: 'fetch', arguments: { id: MEMO_ID } }));
  assert(engMemoFetch.error === 'not_found', 'fetch: engineer is ACL-trimmed from the legal memo (not_found)');
  const legalMemoFetch = body(await legal.callTool({ name: 'fetch', arguments: { id: MEMO_ID } }));
  assert(
    legalMemoFetch.id === MEMO_ID && legalMemoFetch.title,
    'fetch: legal counsel CAN fetch the legal memo',
  );

  // traverse — starting AT the memo id. Engineer cannot even resolve the start
  // node (not_found); legal resolves it to the memo entity.
  const engMemoTraverse = body(await engineer.callTool({ name: 'traverse', arguments: { entityId: MEMO_ID } }));
  assert(
    engMemoTraverse.error === 'not_found',
    'traverse: engineer cannot resolve the legal memo as a start node (not_found)',
  );
  const legalMemoTraverse = body(await legal.callTool({ name: 'traverse', arguments: { entityId: MEMO_ID } }));
  assert(
    legalMemoTraverse.start?.id === MEMO_ID,
    'traverse: legal counsel CAN resolve the legal memo as a start node',
  );

  // get_project_context — pass the memo id as projectId. The ACL check happens
  // BEFORE the type check, so the engineer gets not_found while legal (who can
  // read it) gets not_a_project. The two error codes prove the gate is ACL,
  // not type: the engineer never even learns the entity exists.
  const engMemoCtx = body(
    await engineer.callTool({ name: 'get_project_context', arguments: { projectId: MEMO_ID } }),
  );
  assert(
    engMemoCtx.error === 'not_found',
    'get_project_context: engineer is ACL-trimmed from the legal memo (not_found, not not_a_project)',
  );
  const legalMemoCtx = body(
    await legal.callTool({ name: 'get_project_context', arguments: { projectId: MEMO_ID } }),
  );
  assert(
    legalMemoCtx.error === 'not_a_project' && legalMemoCtx.id === MEMO_ID,
    'get_project_context: legal counsel CAN read the memo (sees not_a_project, proving visibility)',
  );

  // find_experts — its only path to entities is store.search under the caller,
  // so it is trimmed by the same gate. The memo authored by "Outside counsel"
  // (a string, not a person entity) must never surface as an expert or as
  // evidence for the engineer; query terms that match the memo are used to be
  // adversarial. (No person entity is reachable from the memo, so legal simply
  // gets no_results here — the property under test is that the engineer never
  // sees memo-derived evidence, which is satisfied for both.)
  const engExperts = body(
    await engineer.callTool({ name: 'find_experts', arguments: { query: 'privileged legal memo claim counsel' } }),
  );
  const engExpertEvidenceIds = (engExperts.experts ?? []).flatMap((e) => (e.evidence ?? []).map((ev) => ev.id));
  assert(
    !engExpertEvidenceIds.includes(MEMO_ID) && !(engExperts.experts ?? []).some((e) => e.id === MEMO_ID),
    'find_experts: the legal memo never appears as an expert or as evidence for the engineer',
  );

  // =========================================================================
  // (b) Cross-tenant isolation — another firm's token retrieves NOTHING from
  //     every tool, even for the demo tenant's public, well-known entities.
  // =========================================================================
  const otherSearch = body(await other.callTool({ name: 'search', arguments: { query: 'curtain wall firestop' } }));
  assert(otherSearch.no_results === true, 'cross-tenant: search returns no_results for another firm');

  const otherFetch = body(await other.callTool({ name: 'fetch', arguments: { id: PROJECT_ID } }));
  assert(otherFetch.error === 'not_found', 'cross-tenant: fetch of a demo-tenant entity is not_found for another firm');

  const otherFetchMemo = body(await other.callTool({ name: 'fetch', arguments: { id: MEMO_ID } }));
  assert(otherFetchMemo.error === 'not_found', 'cross-tenant: fetch of the legal memo is not_found for another firm');

  const otherTraverse = body(await other.callTool({ name: 'traverse', arguments: { entityId: PROJECT_ID } }));
  assert(otherTraverse.error === 'not_found', 'cross-tenant: traverse of a demo-tenant entity is not_found for another firm');

  const otherExperts = body(await other.callTool({ name: 'find_experts', arguments: { query: 'curtain wall firestop' } }));
  assert(otherExperts.no_results === true, 'cross-tenant: find_experts returns no_results for another firm');

  const otherCtx = body(await other.callTool({ name: 'get_project_context', arguments: { projectId: PROJECT_ID } }));
  assert(otherCtx.error === 'not_found', 'cross-tenant: get_project_context by id is not_found for another firm');
  const otherCtxQuery = body(await other.callTool({ name: 'get_project_context', arguments: { query: 'Riverside' } }));
  assert(otherCtxQuery.no_results === true, 'cross-tenant: get_project_context by name finds nothing for another firm');

  // Control: the engineer (correct tenant) CAN read these — proves the
  // cross-tenant no_results above are isolation, not an empty graph.
  const engCtrlSearch = body(await engineer.callTool({ name: 'search', arguments: { query: 'curtain wall firestop' } }));
  assert(engCtrlSearch.results?.length > 0, 'control: same-tenant engineer search returns seeded results');
  const engCtrlCtx = body(await engineer.callTool({ name: 'get_project_context', arguments: { projectId: PROJECT_ID } }));
  assert(engCtrlCtx.project?.id === PROJECT_ID, 'control: same-tenant engineer reads the Riverside project');

  // =========================================================================
  // (c) The LFI fix — ingest is confined to EKG_UPLOAD_ROOT.
  // =========================================================================
  const ingInside = body(await engineer.callTool({ name: 'ingest_document', arguments: { path: insideFile } }));
  assert(
    ingInside.status === 'queued_unverified' && ingInside.id,
    'LFI: a file INSIDE the upload root ingests as an unverified candidate',
  );

  const ingOutside = body(await engineer.callTool({ name: 'ingest_document', arguments: { path: outsideFile } }));
  assert(
    ingOutside.error === 'path_not_allowed',
    'LFI: a path OUTSIDE the upload root is refused (path_not_allowed)',
  );

  const ingTraversal = body(
    await engineer.callTool({
      name: 'ingest_document',
      arguments: { path: join(uploadRoot, '..', 'host-secret.txt') },
    }),
  );
  assert(
    ingTraversal.error === 'path_not_allowed',
    "LFI: a '..' traversal climbing out of the upload root is refused (path_not_allowed)",
  );

  // =========================================================================
  // (d) Default-restricted ingest ACL.
  //     A doc ingested by principal A with NO visibility arg is restricted to
  //     A; principal B (same tenant) cannot read it. visibility:'public' opts
  //     back into tenant-wide reads.
  // =========================================================================
  // ingInside (above) was ingested by the engineer with no visibility arg.
  const ownerFetch = body(await engineer.callTool({ name: 'fetch', arguments: { id: ingInside.id } }));
  assert(ownerFetch.id === ingInside.id, "default-ACL: the uploader (principal A) CAN read their own ingested doc");

  const bFetchRestricted = body(await engineerB.callTool({ name: 'fetch', arguments: { id: ingInside.id } }));
  assert(
    bFetchRestricted.error === 'not_found',
    'default-ACL: principal B in the same tenant CANNOT read A’s default-ingested doc (not tenant-public)',
  );
  // And it must not leak into B's search either.
  const bSearchRestricted = body(
    await engineerB.callTool({ name: 'search', arguments: { query: 'firestop compression spec Riverside' } }),
  );
  assert(
    !(bSearchRestricted.results ?? []).some((r) => r.id === ingInside.id),
    'default-ACL: A’s default-ingested doc never appears in principal B’s search',
  );

  // visibility:'public' makes it readable by another principal in the tenant.
  const ingPublic = body(
    await engineer.callTool({
      name: 'ingest_document',
      arguments: { path: insidePublicFile, visibility: 'public' },
    }),
  );
  assert(ingPublic.id, 'default-ACL: public ingest succeeds');
  const bFetchPublic = body(await engineerB.callTool({ name: 'fetch', arguments: { id: ingPublic.id } }));
  assert(
    bFetchPublic.id === ingPublic.id,
    "default-ACL: visibility:'public' makes the doc readable by principal B (tenant-wide)",
  );
  // ...but still ONLY tenant-wide — another firm still cannot read a "public" doc.
  const otherFetchPublic = body(await other.callTool({ name: 'fetch', arguments: { id: ingPublic.id } }));
  assert(
    otherFetchPublic.error === 'not_found',
    "default-ACL: even a visibility:'public' doc is not readable across tenants",
  );

  // Close the MCP clients before the raw-JWT block; from here we only use fetch.
  for (const c of clients) await c.close().catch(() => {});
  clients.length = 0;

  // =========================================================================
  // (e) JWT hardening at /mcp — every malformed/forged token is a 401, never
  //     a 500 and never a path to a handler.
  // =========================================================================

  // Missing bearer entirely.
  const noBearer = await rawInitialize(undefined);
  assert(noBearer.status === 401, 'JWT: missing bearer token → 401');

  // Bearer present but not a JWT at all.
  const garbage = await rawInitialize('Bearer not-a-jwt');
  assert(garbage.status === 401, 'JWT: non-JWT bearer → 401');

  // Forged signature: valid header+payload, signature replaced with junk.
  const goodTok = sign({ tid: 'demo-firm', sub: 'user:priya', groups: ['group:engineering'] });
  const [h, p] = goodTok.split('.');
  const forgedSig = `${h}.${p}.${b64url('totally-bogus-signature-bytes')}`;
  const forged = await rawInitialize(`Bearer ${forgedSig}`);
  assert(forged.status === 401, 'JWT: forged signature → 401');

  // Signature made with the WRONG secret — the most realistic forgery.
  const wrongSecretTok = sign({ tid: 'demo-firm', sub: 'user:priya', groups: ['group:engineering'] }, 'attacker-secret');
  const wrongSecret = await rawInitialize(`Bearer ${wrongSecretTok}`);
  assert(wrongSecret.status === 401, 'JWT: token signed with the wrong secret → 401');

  // alg:"none" — header swapped to alg:none with an empty signature, the
  // classic JWT downgrade. The verifier is HS256-only, so this must fail.
  const noneHeader = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const nonePayload = b64url(JSON.stringify({ tid: 'demo-firm', sub: 'user:priya', groups: ['group:engineering'] }));
  const noneTokEmpty = `${noneHeader}.${nonePayload}.`;
  const noneEmpty = await rawInitialize(`Bearer ${noneTokEmpty}`);
  assert(noneEmpty.status === 401, 'JWT: alg:"none" token with empty signature → 401');
  // ...and with the literal text "none" as the signature, another common bypass.
  const noneTokText = `${noneHeader}.${nonePayload}.${b64url('none')}`;
  const noneText = await rawInitialize(`Bearer ${noneTokText}`);
  assert(noneText.status === 401, 'JWT: alg:"none" token with a "none" signature → 401');

  // Tampered payload carrying a VALID old signature: take a properly signed
  // token, swap its payload for an escalated one (legal group), keep the old
  // signature. The HMAC no longer covers the new payload → 401.
  const baseTok = sign({ tid: 'demo-firm', sub: 'user:priya', groups: ['group:engineering'] });
  const [bh, , bsig] = baseTok.split('.');
  const escalatedPayload = b64url(JSON.stringify({ tid: 'demo-firm', sub: 'user:priya', groups: ['group:legal'] }));
  const tamperedTok = `${bh}.${escalatedPayload}.${bsig}`;
  const tampered = await rawInitialize(`Bearer ${tamperedTok}`);
  assert(tampered.status === 401, 'JWT: tampered payload with a valid old signature → 401');

  // Expired token: correctly signed, but exp is in the past.
  const expiredTok = sign({
    tid: 'demo-firm',
    sub: 'user:priya',
    groups: ['group:engineering'],
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  const expired = await rawInitialize(`Bearer ${expiredTok}`);
  assert(expired.status === 401, 'JWT: expired exp → 401');

  // Sanity: a correctly signed, unexpired token is NOT 401 — proves the 401s
  // above are the crafted defects, not a blanket reject of the /mcp endpoint.
  const valid = await rawInitialize(`Bearer ${goodTok}`);
  assert(valid.status !== 401, 'JWT: a valid token is accepted (control — not a blanket 401)');

  console.log(`\nsecurity.test: all ${passed} checks passed`);
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
