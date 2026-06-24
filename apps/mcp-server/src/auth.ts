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
 * Per-request `resolveCaller` for the HTTP gateway: derive the tenant-scoped,
 * permission-bearing caller from the verified token. Fails closed — the HTTP
 * layer rejects unauthenticated requests before any handler runs, so absent
 * claims here is a bug, not a path to an unscoped read.
 */
export function resolveCallerFromAuth(authInfo?: AuthInfo): Caller {
  const claims = authInfo?.extra?.claims as EkgClaims | undefined;
  if (!claims) throw new Error('no authenticated caller on request');
  return {
    tenantId: claims.tid,
    principals: [claims.sub, ...(claims.groups ?? [])],
  };
}
