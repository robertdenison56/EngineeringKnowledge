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
} from './auth.js';

/**
 * The remote gateway transport (PRD P0-3): Streamable HTTP with per-request
 * identity. This is what makes the gateway multi-user — every request carries
 * its own bearer token, so ACL trimming and tenant isolation follow the actual
 * caller instead of a fixed dev identity. Auth here is a dev-secret JWT; the
 * deferred OAuth 2.1 + Entra phase swaps only the verifier (see auth.ts).
 */

const MCP_PATH = '/mcp';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export async function startHttp(): Promise<void> {
  const secret = process.env.EKG_JWT_SECRET;
  if (!secret) {
    console.error(
      'ekg-mcp: EKG_JWT_SECRET is required for the HTTP transport. Set a dev secret, e.g.\n' +
        '  EKG_JWT_SECRET=dev-secret EKG_TRANSPORT=http node dist/index.js',
    );
    process.exit(1);
  }
  const port = Number(process.env.EKG_PORT ?? 8787);

  // The remote gateway must not read arbitrary host files from a network-
  // supplied path. `ingest_document` path reads are confined to EKG_UPLOAD_ROOT;
  // when it is unset they are refused entirely (documents are added through the
  // workspace app instead). Surface that so an admin isn't surprised.
  if (!process.env.EKG_UPLOAD_ROOT) {
    console.error(
      'ekg-mcp: EKG_UPLOAD_ROOT is not set — ingest_document path reads are disabled over HTTP. ' +
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
    handle(req as IncomingMessage & { auth?: AuthInfo }, res, { store, secret, sessions, audit }).catch(
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

interface HandlerContext {
  store: GraphStore;
  secret: string;
  sessions: Map<string, Session>;
  audit: AuditSink;
}

async function handle(
  req: IncomingMessage & { auth?: AuthInfo },
  res: ServerResponse,
  { store, secret, sessions, audit }: HandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Unauthenticated liveness probe for load balancers / deploy checks.
  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok', name: 'ekg-mcp', transport: 'http' });
  }
  if (url.pathname !== MCP_PATH) {
    return sendJson(res, 404, { error: 'not_found' });
  }

  // Authenticate EVERY MCP request — POST tool calls, the GET notification
  // stream, and DELETE teardown alike. Identity is a bearer JWT whose verified
  // claims become the request's caller (PRD P0-3, P0-7). Fail closed.
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return sendJson(res, 401, { error: 'unauthorized', message: 'Bearer token required' });
  }
  try {
    req.auth = authInfoFromClaims(token, verifyToken(token, secret));
  } catch (err) {
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
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
