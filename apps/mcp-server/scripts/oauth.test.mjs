#!/usr/bin/env node
/**
 * OAuth 2.1 resource-server test for the remote gateway (ADR 0011).
 *
 * Runs a mock OIDC identity provider in-process — real RSA keys, a discovery
 * document, and a JWKS endpoint — then spawns the built gateway pointed at it
 * (EKG_OIDC_ISSUER / EKG_OIDC_AUDIENCE) and proves:
 *
 *   (a) RFC 9728 protected-resource metadata is served, and every 401
 *       challenge points at it, so an OAuth client can discover the
 *       authorization server with no out-of-band config.
 *   (b) A valid RS256 token audienced to the gateway is accepted end-to-end
 *       (JWKS discovered, signature checked, claims mapped) and the caller's
 *       identity comes from `oid`, the stable Entra object id — proven via
 *       the audit trail, not just a 200.
 *   (c) Wrong audience / wrong issuer / expired / alg:none / unknown key /
 *       key-kid mismatch are all rejected, and — critically — an HS256 token
 *       signed with EKG_JWT_SECRET is rejected too: in OIDC mode the dev
 *       verifier is dead, never a fallback.
 *   (d) Key rotation: a token signed by a key published *after* the gateway
 *       cached the JWKS verifies via refetch-on-unknown-kid.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, generateKeyPairSync, sign as signRaw } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const IDP_PORT = Number(process.env.OAUTH_TEST_IDP_PORT ?? 8821);
const GW_PORT = Number(process.env.OAUTH_TEST_GW_PORT ?? 8822);
const ISSUER = `http://localhost:${IDP_PORT}`;
const AUDIENCE = 'api://ekg-gateway-test';
const DEV_SECRET = 'must-be-ignored-in-oidc-mode';
const gwBase = `http://localhost:${GW_PORT}`;

function assert(cond, label) {
  if (!cond) throw new Error(`oauth.test failed: ${label}`);
  console.log(`ok - ${label}`);
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

// --- Mock identity provider ------------------------------------------------
const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyRogue = generateKeyPairSync('rsa', { modulusLength: 2048 }); // never published

// The JWKS the IdP serves — mutable so the test can rotate a key in later.
const publishedKeys = [{ ...keyA.publicKey.export({ format: 'jwk' }), kid: 'kid-a', use: 'sig', alg: 'RS256' }];

const idp = createServer((req, res) => {
  const respond = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/.well-known/openid-configuration') {
    return respond({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
  }
  if (req.url === '/jwks') {
    return respond({ keys: publishedKeys });
  }
  res.writeHead(404).end();
});
await new Promise((r) => idp.listen(IDP_PORT, r));

function signRs256(claims, privateKey, kid) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = signRaw('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function signHs256(claims, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
/** A valid claim set an Entra access token would carry, overridable per test. */
function claims(overrides = {}) {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    exp: now() + 3600,
    tid: 'demo-firm',
    // Entra's `sub` is pairwise per app registration; `oid` is the stable
    // object id ACLs are written against. The gateway must prefer oid.
    sub: 'pairwise-opaque-subject',
    oid: 'user:dev',
    groups: ['group:engineering'],
    ...overrides,
  };
}

// --- Gateway under test ----------------------------------------------------
const auditPath = join(tmpdir(), `ekg-audit-oauth-${process.pid}.jsonl`);
const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
  env: {
    ...process.env,
    EKG_TRANSPORT: 'http',
    EKG_PORT: String(GW_PORT),
    EKG_DB_PATH: '',
    EKG_AUDIT_LOG: auditPath,
    EKG_OIDC_ISSUER: ISSUER,
    EKG_OIDC_AUDIENCE: AUDIENCE,
    // Rotation refetches un-throttled so the key-rotation check is
    // deterministic; production default is 60s.
    EKG_OIDC_JWKS_MIN_REFRESH_MS: '0',
    // Present on purpose: OIDC mode must ignore it (checked below).
    EKG_JWT_SECRET: DEV_SECRET,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${gwBase}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('gateway did not become ready on /healthz');
}

/** POST an initialize request with the given token; returns the Response. */
function tryInitialize(token) {
  return fetch(`${gwBase}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'oauth-test', version: '0' } },
    }),
  });
}

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${gwBase}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'oauth-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function cleanup() {
  rmSync(auditPath, { force: true });
  child.kill();
  idp.close();
}

try {
  await waitReady();
  assert(true, 'gateway is listening in OAuth resource-server mode');

  // (a) RFC 9728 metadata + challenge discovery.
  const meta = await (await fetch(`${gwBase}/.well-known/oauth-protected-resource`)).json();
  assert(meta.resource === AUDIENCE, 'metadata advertises the resource identifier (aud tokens must carry)');
  assert(
    Array.isArray(meta.authorization_servers) && meta.authorization_servers[0] === ISSUER,
    'metadata points at the Entra issuer as the authorization server',
  );
  const noTok = await tryInitialize(undefined);
  assert(noTok.status === 401, 'no token → 401');
  const chal = noTok.headers.get('www-authenticate') ?? '';
  assert(
    chal.includes(`resource_metadata="${gwBase}/.well-known/oauth-protected-resource"`),
    '401 challenge carries resource_metadata so a client can self-discover (RFC 9728)',
  );

  // (c) Every malformed / mis-issued token shape is refused.
  const rejections = [
    ['wrong audience', signRs256(claims({ aud: 'api://someone-else' }), keyA.privateKey, 'kid-a')],
    ['wrong issuer', signRs256(claims({ iss: 'http://evil.example' }), keyA.privateKey, 'kid-a')],
    ['expired (past skew)', signRs256(claims({ exp: now() - 3600 }), keyA.privateKey, 'kid-a')],
    ['missing exp', signRs256(claims({ exp: undefined }), keyA.privateKey, 'kid-a')],
    ['missing tid', signRs256(claims({ tid: undefined }), keyA.privateKey, 'kid-a')],
    [
      'alg:none',
      `${b64url(JSON.stringify({ alg: 'none', kid: 'kid-a' }))}.${b64url(JSON.stringify(claims()))}.`,
    ],
    ['HS256 dev token in OIDC mode (dev verifier must be dead)', signHs256({ tid: 'demo-firm', sub: 'user:dev' }, DEV_SECRET)],
    ['unpublished key / unknown kid', signRs256(claims(), keyRogue.privateKey, 'kid-rogue')],
    ['signature from the wrong key under a known kid', signRs256(claims(), keyB.privateKey, 'kid-a')],
  ];
  for (const [label, token] of rejections) {
    const res = await tryInitialize(token);
    assert(res.status === 401, `rejected: ${label}`);
  }
  const badChal = (await tryInitialize('garbage')).headers.get('www-authenticate') ?? '';
  assert(
    badChal.includes('error="invalid_token"') && badChal.includes('resource_metadata='),
    'invalid-token challenge carries both the error and the metadata pointer',
  );

  // (b) A valid token works end-to-end and maps identity from oid.
  const good = await connect(signRs256(claims(), keyA.privateKey, 'kid-a'));
  const search = await good.callTool({ name: 'search', arguments: { query: 'curtain wall firestop' } });
  const payload = JSON.parse(search.content[0].text);
  assert(payload.results?.length > 0, 'valid RS256 token reaches the graph (JWKS discovered + verified)');
  await good.close();
  const audited = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const searchEvent = audited.find((e) => e.tool === 'search');
  assert(
    searchEvent?.principal === 'user:dev' && searchEvent?.tenantId === 'demo-firm',
    'caller identity maps from oid (stable object id), not the pairwise sub — proven in the audit trail',
  );

  // (d) Key rotation: publish kid-b after the gateway cached the JWKS; a
  // token signed with it verifies via refetch-on-unknown-kid.
  publishedKeys.push({ ...keyB.publicKey.export({ format: 'jwk' }), kid: 'kid-b', use: 'sig', alg: 'RS256' });
  const rotated = await connect(signRs256(claims({ oid: 'user:rotated' }), keyB.privateKey, 'kid-b'));
  const rotatedSearch = await rotated.callTool({ name: 'search', arguments: { query: 'firestop' } });
  assert(
    JSON.parse(rotatedSearch.content[0].text).results?.length > 0,
    'a key published after startup verifies (JWKS refetch on unknown kid — rotation works)',
  );
  await rotated.close();

  console.log('oauth.test: all checks passed');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error(String(err));
  cleanup();
  process.exit(1);
}
