import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Caller } from '@ekg/core';

/**
 * Per-request identity for the remote HTTP gateway (PRD P0-3, P0-7).
 *
 * The dev gateway accepts a bearer JWT (HS256, shared secret) carrying the
 * tenant and the caller's principals — deliberately the same claim shape a
 * federated Entra token will provide. When OAuth 2.1 + Entra federation lands
 * (the deferred G2 phase), only the verifier changes: `verifyToken` becomes a
 * JWKS/OIDC check, `resolveCallerFromAuth` and every downstream consumer stay
 * put. Identity is HS256-signed with `node:crypto` so the gateway carries no
 * crypto dependency — matching the project's no-native-deps stance.
 */
export interface EkgClaims {
  /** Tenant id — scopes every read at the data layer. */
  tid: string;
  /** The user principal, e.g. "user:priya". */
  sub: string;
  /** Group principals (Entra group object ids in production), e.g. ["group:legal"]. */
  groups?: string[];
  iss?: string;
  iat?: number;
  /** Expiry, seconds since epoch. */
  exp?: number;
}

/** A token that fails verification — surfaced as a 401, never a 500. */
export class TokenError extends Error {}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/**
 * Mint a dev token. Used by tests and local tooling; the production gateway
 * never signs tokens, it only verifies them against the identity provider.
 */
export function signDevToken(claims: EkgClaims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Verify an HS256 token and return its claims, or throw TokenError. */
export function verifyToken(token: string, secret: string): EkgClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed token');
  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const got = Buffer.from(sig, 'base64url');
  // Length check first — timingSafeEqual throws on a length mismatch.
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new TokenError('bad signature');
  }
  let claims: EkgClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as EkgClaims;
  } catch {
    throw new TokenError('unparseable claims');
  }
  if (!claims.tid || !claims.sub) throw new TokenError('missing tid/sub claim');
  if (claims.exp !== undefined && Date.now() / 1000 > claims.exp) {
    throw new TokenError('token expired');
  }
  return claims;
}

/** Extract a bearer token from an Authorization header, if present. */
export function bearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/** Wrap verified claims as the SDK's AuthInfo, stashing claims for resolution. */
export function authInfoFromClaims(token: string, claims: EkgClaims): AuthInfo {
  return {
    token,
    clientId: claims.sub,
    scopes: [],
    expiresAt: claims.exp,
    extra: { claims },
  };
}

/**
 * Role principals — the same literal strings the workspace app's `auth.ts` /
 * `store.ts` use (kept literal there too; the strings are the cross-surface
 * authorization contract, PRD P0-9). Before this port existed, the gateway
 * never built role principals at all, so the same human was a curator in the
 * app and a nobody at the gateway — and the gateway's mutating tools, having
 * no writer to check for, checked nothing.
 */
export const ADMIN_PRINCIPAL = 'role:admin';
export const CURATOR_PRINCIPAL = 'role:curator';

/**
 * The slice of the environment that maps directory groups onto roles —
 * deliberately the SAME two variables the workspace app reads, so one Entra
 * group grant makes someone a curator on every surface at once.
 * Comma-separated group ids; entries may be bare Entra object ids (what an
 * OIDC token carries) or `group:`-prefixed dev principals.
 */
export interface RoleEnv {
  EKG_ADMIN_GROUP?: string;
  EKG_CURATOR_GROUP?: string;
}

/** Strip the dev `group:` prefix so bare OIDC object ids and dev principals compare equal. */
function bareGroup(value: string): string {
  return value.replace(/^group:/, '');
}

/** Does any of the caller's directory groups appear in the configured list? */
function inConfiguredGroup(groups: string[], configured: string | undefined): boolean {
  if (!configured) return false;
  const wanted = new Set(
    configured
      .split(',')
      .map((s) => bareGroup(s.trim()))
      .filter(Boolean),
  );
  return groups.some((g) => wanted.has(bareGroup(g)));
}

/** Whether a caller may change workspace-wide settings (mirrors the web app). */
export function isAdmin(caller: Caller): boolean {
  return caller.principals.includes(ADMIN_PRINCIPAL);
}

/**
 * Whether a caller may write to the graph through the gateway's mutating
 * tools. Same semantics as the workspace app's `isCurator`: curation rights,
 * with admin curating implicitly. This is the authorization boundary the
 * write gate in `server.ts` checks on every mutating call.
 */
export function isCurator(caller: Caller): boolean {
  return caller.principals.includes(CURATOR_PRINCIPAL) || isAdmin(caller);
}

/**
 * Per-request `resolveCaller` for the HTTP gateway: derive the tenant-scoped,
 * permission-bearing caller from the verified token. Fails closed — the HTTP
 * layer rejects unauthenticated requests before any handler runs, so absent
 * claims here is a bug, not a path to an unscoped read.
 *
 * Roles are granted ONLY through the {@link RoleEnv} group mapping — never
 * taken from the token itself. Token-supplied principals are stripped of
 * `role:*` first: without that, a token claiming `groups: ["role:curator"]`
 * would BE a curator, and the role boundary would be self-issued rather than
 * directory-managed. (An Entra token's `groups` are object-id GUIDs, so real
 * tokens lose nothing.)
 */
export function resolveCallerFromAuth(authInfo?: AuthInfo, env: RoleEnv = process.env): Caller {
  const claims = authInfo?.extra?.claims as EkgClaims | undefined;
  if (!claims) throw new Error('no authenticated caller on request');
  const groups = (claims.groups ?? []).filter((g) => !g.startsWith('role:'));
  const roles: string[] = [];
  if (inConfiguredGroup(groups, env.EKG_ADMIN_GROUP)) roles.push(ADMIN_PRINCIPAL);
  if (inConfiguredGroup(groups, env.EKG_CURATOR_GROUP)) roles.push(CURATOR_PRINCIPAL);
  const sub = claims.sub.startsWith('role:') ? [] : [claims.sub];
  return {
    tenantId: claims.tid,
    principals: [...sub, ...groups, ...roles],
  };
}
