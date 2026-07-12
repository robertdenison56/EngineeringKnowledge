#!/usr/bin/env node
/**
 * End-to-end SIGN-OFF for a DEPLOYED remote gateway (PRD P0-3, P0-7).
 *
 * Unlike `smoke-http.mjs` — which spawns its own in-memory demo server in CI —
 * this drives a gateway that is already running at a URL you give it, over the
 * same Streamable HTTP + bearer-JWT path a real MCP client uses. It is the
 * runnable half of the "remote gateway is live and correct" sign-off an admin
 * records before pointing assistants at a deployment (see the Administration
 * guide → "End-to-end sign-off").
 *
 * It asserts the contract that holds for ANY deployment (liveness, fail-closed
 * auth, the served tool surface, a well-formed `search` envelope with
 * provenance), and — when the deployment serves the seeded DEMO graph
 * (EKG_SIGNOFF_DEMO=1) — the multi-identity proofs: ACL trimming and tenant
 * isolation follow the token, not a fixed caller.
 *
 * Configuration (environment):
 *   EKG_SIGNOFF_URL     Base URL of the gateway, e.g. https://ekg.yourfirm.com
 *                       (a trailing "/mcp" is accepted and stripped). REQUIRED.
 *   EKG_JWT_SECRET      HS256 secret the gateway verifies with. If set, this
 *                       script MINTS the caller token(s) itself — and is the
 *                       only way to run the multi-identity demo proofs.
 *   EKG_SIGNOFF_TOKEN   A pre-minted bearer JWT to use instead of minting.
 *                       (One of EKG_JWT_SECRET or EKG_SIGNOFF_TOKEN is required.)
 *   EKG_SIGNOFF_TENANT  Primary caller tenant id      (default "demo-firm").
 *   EKG_SIGNOFF_SUB     Primary caller subject        (default "user:priya").
 *   EKG_SIGNOFF_GROUPS  Primary caller groups, comma  (default "group:engineering").
 *   EKG_SIGNOFF_QUERY   Query for the generic search check (default "firestop").
 *   EKG_SIGNOFF_DEMO    "1" to also run the seeded-graph ACL/tenant proofs
 *                       (requires EKG_JWT_SECRET so the extra tokens can be minted).
 *
 * Exit code is 0 only when every executed check passed (skips are allowed).
 */
import { createHmac } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---- config -----------------------------------------------------------------

const rawUrl = process.env.EKG_SIGNOFF_URL;
if (!rawUrl) {
  fail('EKG_SIGNOFF_URL is required, e.g. EKG_SIGNOFF_URL=https://ekg.yourfirm.com');
}
// Accept either the base URL or the full /mcp endpoint; normalize to a base.
const base = rawUrl.replace(/\/+$/, '').replace(/\/mcp$/, '');
const mcpUrl = `${base}/mcp`;
const healthUrl = `${base}/healthz`;

const secret = process.env.EKG_JWT_SECRET;
const presetToken = process.env.EKG_SIGNOFF_TOKEN;
if (!secret && !presetToken) {
  fail('Set EKG_JWT_SECRET (to mint tokens) or EKG_SIGNOFF_TOKEN (a pre-minted JWT).');
}

const tenant = process.env.EKG_SIGNOFF_TENANT ?? 'demo-firm';
const sub = process.env.EKG_SIGNOFF_SUB ?? 'user:priya';
const groups = (process.env.EKG_SIGNOFF_GROUPS ?? 'group:engineering')
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean);
const genericQuery = process.env.EKG_SIGNOFF_QUERY ?? 'firestop';
const demo = process.env.EKG_SIGNOFF_DEMO === '1';

// ---- token minting (mirrors src/auth.ts) ------------------------------------

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function sign(claims) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }));
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

const primaryToken = presetToken ?? sign({ tid: tenant, sub, groups });

// ---- result accounting ------------------------------------------------------

const results = [];
function record(status, label, detail) {
  results.push({ status, label, detail });
  const mark = status === 'pass' ? 'ok  ' : status === 'skip' ? 'skip' : 'FAIL';
  console.log(`${mark} - ${label}${detail ? `  (${detail})` : ''}`);
}
const check = (cond, label, detail) => record(cond ? 'pass' : 'fail', label, cond ? undefined : detail);
const skip = (label, why) => record('skip', label, why);

function fail(message) {
  console.error(`signoff-remote: ${message}`);
  process.exit(1);
}

// ---- MCP helpers ------------------------------------------------------------

function bodyOf(result) {
  return JSON.parse(result.content[0].text);
}
async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'ekg-signoff', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// ---- run --------------------------------------------------------------------

const READ_TOOLS = ['search', 'fetch', 'traverse', 'find_experts', 'get_project_context'];
const clients = [];

console.log(`EKG remote gateway sign-off → ${mcpUrl}\n`);

try {
  // 1. Liveness — the unauthenticated probe load balancers use.
  try {
    const r = await fetch(healthUrl);
    const j = await r.json().catch(() => ({}));
    check(r.ok && j.status === 'ok', 'GET /healthz is live and unauthenticated', `status=${r.status}`);
  } catch (err) {
    check(false, 'GET /healthz is live and unauthenticated', String(err?.message ?? err));
    throw new Error(`gateway unreachable at ${base} — is the URL right and the server up?`);
  }

  // 2. Fail-closed auth: no token and a bad token are rejected before any handler.
  const noAuth = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }),
  });
  check(noAuth.status === 401, 'unauthenticated /mcp request is rejected (401)', `status=${noAuth.status}`);

  const badAuth = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' },
    body: '{}',
  });
  check(badAuth.status === 401, 'invalid bearer token is rejected (401)', `status=${badAuth.status}`);

  // 3. A valid token initializes a session and the gateway serves its tools.
  const primary = await connect(primaryToken);
  clients.push(primary);
  record('pass', `valid token initializes a Streamable HTTP session (${sub} @ ${tenant})`);

  const toolNames = (await primary.listTools()).tools.map((t) => t.name).sort();
  check(
    READ_TOOLS.every((n) => toolNames.includes(n)),
    'gateway serves the P0-3 tool surface',
    `got: ${toolNames.join(', ')}`,
  );

  // 4. `search` returns a well-formed envelope (the connector contract). Either
  //    real results (each carrying provenance + an app URL) or an explicit
  //    no_results — both are correct; a fresh curated graph may legitimately
  //    have no hit for a guessed term.
  const search = bodyOf(await primary.callTool({ name: 'search', arguments: { query: genericQuery } }));
  const wellFormed = Array.isArray(search.results) || search.no_results === true;
  check(wellFormed, `search("${genericQuery}") returns a well-formed envelope`, JSON.stringify(search).slice(0, 120));
  if (Array.isArray(search.results) && search.results.length > 0) {
    const first = search.results[0];
    check(
      Boolean(first.provenance?.reviewStatus && first.url),
      'search results carry provenance + an app URL (P0-8)',
      JSON.stringify(first).slice(0, 120),
    );
  } else {
    skip('search results carry provenance + an app URL (P0-8)', `no hits for "${genericQuery}" — try EKG_SIGNOFF_QUERY`);
  }

  // 5. Demo-graph proofs: ACL trimming + tenant isolation vary by token. These
  //    assert against the SEEDED demo corpus, so they only run when the
  //    deployment serves it AND we can mint the extra identities.
  const ACL_MEMO = 'document:claims-memo-riverside';
  if (!demo) {
    skip('ACL trimming follows the token (seeded memo)', 'set EKG_SIGNOFF_DEMO=1 on a demo-graph deployment');
    skip('a second identity sees what its ACL allows', 'demo-only');
    skip('cross-tenant token retrieves nothing (isolation)', 'demo-only');
  } else if (!secret) {
    skip('ACL trimming follows the token (seeded memo)', 'needs EKG_JWT_SECRET to mint the extra identities');
    skip('a second identity sees what its ACL allows', 'needs EKG_JWT_SECRET');
    skip('cross-tenant token retrieves nothing (isolation)', 'needs EKG_JWT_SECRET');
  } else {
    // Engineer (the primary caller) is ACL-trimmed from the privileged memo.
    const engMemo = bodyOf(await primary.callTool({ name: 'fetch', arguments: { id: ACL_MEMO } }));
    check(engMemo.error === 'not_found', 'ACL trimming follows the token (seeded memo hidden from engineer)', JSON.stringify(engMemo).slice(0, 120));

    // Counsel — SAME server, different token — CAN read it.
    const counsel = await connect(sign({ tid: tenant, sub: 'user:counsel', groups: ['group:legal'] }));
    clients.push(counsel);
    const legalMemo = bodyOf(await counsel.callTool({ name: 'fetch', arguments: { id: ACL_MEMO } }));
    check(legalMemo.id === ACL_MEMO && Boolean(legalMemo.title), 'a second identity (counsel) sees what its ACL allows', JSON.stringify(legalMemo).slice(0, 120));

    // A token for another firm sees nothing — tenant isolation.
    const other = await connect(sign({ tid: 'other-firm', sub: 'user:rival', groups: ['group:engineering'] }));
    clients.push(other);
    const otherSearch = bodyOf(await other.callTool({ name: 'search', arguments: { query: 'curtain wall firestop' } }));
    check(otherSearch.no_results === true, 'cross-tenant token retrieves nothing (tenant isolation)', JSON.stringify(otherSearch).slice(0, 120));
  }
} catch (err) {
  record('fail', 'sign-off run completed without an unexpected error', String(err?.message ?? err));
} finally {
  for (const c of clients) await c.close().catch(() => {});
}

// ---- sign-off report --------------------------------------------------------

const passed = results.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skip').length;
const failed = results.filter((r) => r.status === 'fail').length;
const ok = failed === 0;

const line = '='.repeat(66);
console.log(`\n${line}`);
console.log('  EKG REMOTE GATEWAY — END-TO-END SIGN-OFF');
console.log(line);
console.log(`  URL:        ${mcpUrl}`);
console.log(`  Principal:  ${sub} @ ${tenant}`);
console.log(`  Checked at: ${new Date().toISOString()}`);
console.log(`  Result:     ${ok ? 'PASS' : 'FAIL'}  (${passed} passed, ${failed} failed, ${skipped} skipped)`);
console.log('  Audit:      confirm these calls landed in EKG_AUDIT_LOG / your log');
console.log(`              pipeline, attributed to ${sub} with transport=http (P0-7).`);
console.log(line);

process.exit(ok ? 0 : 1);
