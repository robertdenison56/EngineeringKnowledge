import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { GraphStore } from '@ekg/core';
import { createServer, createStore } from './server.js';
import { auditSinkFromEnv, type AuditSink } from './audit.js';
import {
  authInfoFromClaims,
  bearerToken,
  resolveCallerFromAuth,
  verifyToken,
  TokenError,
  type EkgClaims,
} from './auth.js';
import { oidcConfigFromEnv, OidcVerifier } from './oidc.js';

/**
 * The remote gateway transport (PRD P0-3): Streamable HTTP with per-request
 * identity. This is what makes the gateway multi-user — every request carries
 * its own bearer token, so ACL trimming and tenant isolation follow the actual
 * caller instead of a fixed dev identity.
 *
 * Two verifiers, one seam (ADR 0011): with EKG_OIDC_ISSUER + EKG_OIDC_AUDIENCE
 * set, the gateway runs as an OAuth 2.1 resource server — RS256 tokens checked
 * against the issuer's JWKS, protected-resource metadata served per RFC 9728 —
 * which is what admin-managed claude.ai org connectors (and M365 Copilot)
 * need. Otherwise it verifies dev-secret HS256 tokens (EKG_JWT_SECRET), the
 * local-dev and CI path. Never both for one process.
 */

const MCP_PATH = '/mcp';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export async function startHttp(): Promise<void> {
  // Pick the verifier. OIDC config wins; a half-set OIDC config aborts startup
  // (oidcConfigFromEnv throws) rather than silently downgrading to dev auth.
  let oidcConfig;
  try {
    oidcConfig = oidcConfigFromEnv();
  } catch (err) {
    console.error(`ekg-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let verify: (token: string) => Promise<EkgClaims>;
  let oidc: OidcContext | undefined;
  if (oidcConfig) {
    const verifier = new OidcVerifier(oidcConfig);
    verify = (token) => verifier.verify(token);
    oidc = { issuer: oidcConfig.issuer, resource: oidcConfig.audience };
    console.error(
      `ekg-mcp: OAuth resource-server mode — issuer ${oidcConfig.issuer}, ` +
        `audience ${oidcConfig.audience}` +
        (process.env.EKG_JWT_SECRET ? ' (EKG_JWT_SECRET is ignored in this mode)' : ''),
    );
  } else {
    const secret = process.env.EKG_JWT_SECRET;
    if (!secret) {
      console.error(
        'ekg-mcp: the HTTP transport needs either EKG_OIDC_ISSUER + EKG_OIDC_AUDIENCE (OAuth ' +
          'resource-server mode) or EKG_JWT_SECRET (dev tokens). For local dev, e.g.\n' +
          '  EKG_JWT_SECRET=dev-secret EKG_TRANSPORT=http node dist/index.js',
      );
      process.exit(1);
    }
    verify = async (token) => verifyToken(token, secret);
  }
  const port = Number(process.env.EKG_PORT ?? 8787);

  // The remote gateway must not read arbitrary host files from a network-
  // supplied path. `ingest_document` path reads are confined to EKG_UPLOAD_ROOT
  // (alias EKG_INGEST_ROOT); when it is unset they are refused with
  // `ingest_root_not_configured` (documents are added through the workspace app
  // instead). Surface that so an admin isn't surprised.
  if (!process.env.EKG_UPLOAD_ROOT && !process.env.EKG_INGEST_ROOT) {
    console.error(
      'ekg-mcp: EKG_UPLOAD_ROOT is not set — ingest_document fails closed (ingest_root_not_configured). ' +
        'Set it to a managed upload directory to enable ingest-by-path.',
    );
  }

  // One store and one audit sink, shared across every request — identity is
  // per-request (from the token), these are not. The store is built once so we
  // never re-seed per connection; the sink is shared so all sessions append to
  // one immutable trail (PRD P0-7).
  const store = await createStore();
  const audit = auditSinkFromEnv();

  // Stateful sessions: an MCP client initializes once, then reuses its session
  // id on later requests. Each session owns a server+transport; the token is
  // re-verified on every request regardless, so a session never outlives the
  // validity of its caller's token.
  const sessions = new Map<string, Session>();

  const httpServer = createNodeServer((req, res) => {
    handle(req as IncomingMessage & { auth?: AuthInfo }, res, { store, verify, oidc, sessions, audit }).catch(
      (err) => {
        console.error('ekg-mcp: request error', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      },
    );
  });

  httpServer.listen(port, () => {
    console.error(
      `ekg-mcp: knowledge graph gateway listening on http://localhost:${port}${MCP_PATH}`,
    );
  });
}

/** OIDC-mode extras: what the metadata route and 401 challenges advertise. */
interface OidcContext {
  issuer: string;
  /** The resource identifier tokens must be audienced to (RFC 9728 `resource`). */
  resource: string;
}

interface HandlerContext {
  store: GraphStore;
  verify: (token: string) => Promise<EkgClaims>;
  oidc?: OidcContext;
  sessions: Map<string, Session>;
  audit: AuditSink;
}

/**
 * The absolute URL of our protected-resource metadata, built from the
 * request's own Host (honoring a TLS-terminating proxy's x-forwarded-proto) —
 * the gateway does not need to be told its public origin.
 */
function resourceMetadataUrl(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}${RESOURCE_METADATA_PATH}`;
}

/** RFC 6750 challenge, pointing OAuth-capable clients at our metadata (RFC 9728). */
function challenge(req: IncomingMessage, oidc: OidcContext | undefined, invalid: boolean): string {
  const params: string[] = [];
  if (invalid) params.push('error="invalid_token"');
  if (oidc) params.push(`resource_metadata="${resourceMetadataUrl(req)}"`);
  return params.length ? `Bearer ${params.join(', ')}` : 'Bearer';
}

async function handle(
  req: IncomingMessage & { auth?: AuthInfo },
  res: ServerResponse,
  { store, verify, oidc, sessions, audit }: HandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Unauthenticated liveness probe for load balancers / deploy checks.
  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok', name: 'ekg-mcp', transport: 'http' });
  }
  // Protected-resource metadata (RFC 9728): how an OAuth client discovers
  // where to get a token for this gateway. Unauthenticated by design; only
  // exists in OIDC mode — a dev-secret gateway has no authorization server
  // to advertise.
  if (oidc && url.pathname === RESOURCE_METADATA_PATH) {
    return sendJson(res, 200, {
      resource: oidc.resource,
      authorization_servers: [oidc.issuer],
      bearer_methods_supported: ['header'],
    });
  }
  if (url.pathname !== MCP_PATH) {
    return sendJson(res, 404, { error: 'not_found' });
  }

  // Authenticate EVERY MCP request — POST tool calls, the GET notification
  // stream, and DELETE teardown alike. Identity is a verified bearer token
  // whose claims become the request's caller (PRD P0-3, P0-7). Fail closed.
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    res.setHeader('WWW-Authenticate', challenge(req, oidc, false));
    return sendJson(res, 401, { error: 'unauthorized', message: 'Bearer token required' });
  }
  try {
    req.auth = authInfoFromClaims(token, await verify(token));
  } catch (err) {
    res.setHeader('WWW-Authenticate', challenge(req, oidc, true));
    return sendJson(res, 401, {
      error: 'invalid_token',
      message: err instanceof TokenError ? err.message : 'invalid token',
    });
  }

  const sessionId = req.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

  // Established session: hand the request straight to its transport. The body
  // stream is untouched (we only read headers), so the transport parses it.
  if (existing) {
    return existing.transport.handleRequest(req, res);
  }

  // No live session. Only an initialize POST may open one.
  if (req.method !== 'POST') {
    return sendJson(res, 400, {
      error: 'invalid_session',
      message: 'Unknown or missing session id',
    });
  }
  const body = await readJsonBody(req);
  if (sessionId !== undefined || !isInitializeRequest(body)) {
    return sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'No valid session id; expected an initialize request' },
      id: null,
    });
  }

  // A fresh server + transport for the new session, sharing the one store and
  // resolving identity per-request from the verified token.
  const server = await createServer({
    store,
    resolveCaller: resolveCallerFromAuth,
    audit,
    transport: 'http',
  });
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  // Pass the already-parsed initialize body so the transport doesn't re-read
  // the (now consumed) request stream.
  await transport.handleRequest(req, res, body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}
