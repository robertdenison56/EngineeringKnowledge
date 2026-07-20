import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { TokenError, type EkgClaims } from './auth.js';

/**
 * OAuth 2.1 / OIDC token verification for the remote gateway (ADR 0011).
 *
 * The gateway is a **resource server only** — it never mints tokens. Microsoft
 * Entra ID (or any OIDC-compliant issuer) owns /authorize, /token, consent,
 * and key rotation; we validate the RS256-signed access tokens it issues
 * against the issuer's published JWKS and map the claims onto the same
 * `EkgClaims` shape the dev HS256 verifier produces, so ACL trimming, tenant
 * isolation, and audit downstream are byte-for-byte unchanged.
 *
 * Built on `node:crypto` + global fetch — the gateway keeps its
 * no-native-deps stance.
 */
export interface OidcConfig {
  /** Expected `iss` — the Entra tenant's issuer URL, matched exactly. */
  issuer: string;
  /**
   * Expected `aud` — the gateway's resource identifier (the Entra app
   * registration's Application ID URI, e.g. `api://ekg-gateway`).
   */
  audience: string;
  /** Explicit JWKS URL; when unset it is discovered from the issuer. */
  jwksUri?: string;
  /**
   * Minimum ms between JWKS refetches triggered by an unknown `kid`
   * (default 60s) — key rotation is picked up promptly, but a flood of
   * garbage kids cannot turn the verifier into a fetch loop.
   */
  minRefreshMs?: number;
}

/** Clock skew tolerated on `exp` / `nbf`, seconds. */
const CLOCK_SKEW_S = 300;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_REFRESH_MS = 60_000;

/**
 * Read the OIDC config from the environment. Returns undefined when OIDC mode
 * is not configured at all; throws when it is half-configured — a missing
 * audience must stop the gateway, never silently downgrade it to dev auth.
 */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
  const issuer = env.EKG_OIDC_ISSUER;
  const audience = env.EKG_OIDC_AUDIENCE;
  if (!issuer && !audience) return undefined;
  if (!issuer || !audience) {
    throw new Error(
      'EKG_OIDC_ISSUER and EKG_OIDC_AUDIENCE must be set together — a half-configured ' +
        'OIDC verifier must not fall back to the dev secret.',
    );
  }
  const minRefresh = env.EKG_OIDC_JWKS_MIN_REFRESH_MS;
  return {
    issuer,
    audience,
    jwksUri: env.EKG_OIDC_JWKS_URI,
    ...(minRefresh !== undefined ? { minRefreshMs: Number(minRefresh) } : {}),
  };
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

/** Raw claims as they arrive from the issuer, before mapping to EkgClaims. */
interface OidcPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  tid?: string;
  sub?: string;
  /** Entra: the user's immutable object id — preferred over pairwise `sub`. */
  oid?: string;
  groups?: unknown;
}

function decodeSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    throw new TokenError(`unparseable ${what}`);
  }
}

async function fetchJson(url: string, what: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new TokenError(`${what} unavailable`);
  }
  if (!res.ok) throw new TokenError(`${what} unavailable (HTTP ${res.status})`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new TokenError(`${what} malformed`);
  }
}

/**
 * Verifies RS256 access tokens against the issuer's JWKS. One instance per
 * gateway process: it lazily discovers the JWKS URL, caches keys by `kid`,
 * dedupes concurrent fetches, and refetches (throttled) when a token names a
 * key it has not seen — the standard rotation story.
 */
export class OidcVerifier {
  private readonly config: Required<Pick<OidcConfig, 'issuer' | 'audience' | 'minRefreshMs'>> &
    Pick<OidcConfig, 'jwksUri'>;
  private keys = new Map<string, KeyObject>();
  private lastFetchMs = 0;
  private inflight: Promise<void> | undefined;

  constructor(config: OidcConfig) {
    this.config = { minRefreshMs: DEFAULT_MIN_REFRESH_MS, ...config };
  }

  async verify(token: string): Promise<EkgClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('malformed token');
    const [headerSeg, payloadSeg, sigSeg] = parts;
    const header = decodeSegment<JwtHeader>(headerSeg, 'header');

    // Exactly RS256 — refusing everything else closes the classic
    // alg-confusion holes (none, HS256-with-public-key-as-secret).
    if (header.alg !== 'RS256') throw new TokenError(`unsupported alg ${String(header.alg)}`);
    if (!header.kid) throw new TokenError('missing kid');

    const key = await this.keyFor(header.kid);
    const data = Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8');
    const sig = Buffer.from(sigSeg, 'base64url');
    if (!verifySignature('RSA-SHA256', data, key, sig)) throw new TokenError('bad signature');

    const payload = decodeSegment<OidcPayload>(payloadSeg, 'claims');
    if (payload.iss !== this.config.issuer) throw new TokenError('wrong issuer');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.config.audience)) throw new TokenError('wrong audience');
    const now = Date.now() / 1000;
    // A production access token without an expiry is malformed — reject rather
    // than accept a token that could never be rotated out.
    if (typeof payload.exp !== 'number') throw new TokenError('missing exp');
    if (now > payload.exp + CLOCK_SKEW_S) throw new TokenError('token expired');
    if (typeof payload.nbf === 'number' && now < payload.nbf - CLOCK_SKEW_S) {
      throw new TokenError('token not yet valid');
    }

    // Map onto the dev-token claim shape (ADR 0011): tid ← Entra tenant id,
    // sub ← the immutable object id when present (Entra's `sub` is pairwise
    // per app; `oid` is the stable user identity ACLs are written against),
    // groups ← group object ids. Group-claim overage (Entra omits `groups`
    // past ~200 and points at Graph instead) resolves to no groups — the user
    // sees only their own and tenant-public items. Fails closed, not open.
    if (!payload.tid) throw new TokenError('missing tid claim');
    const sub = payload.oid ?? payload.sub;
    if (!sub) throw new TokenError('missing sub/oid claim');
    const groups = Array.isArray(payload.groups)
      ? payload.groups.filter((g): g is string => typeof g === 'string')
      : undefined;
    return { tid: payload.tid, sub, ...(groups ? { groups } : {}), iss: payload.iss, exp: payload.exp };
  }

  /** The cached key for `kid`, refetching the JWKS (throttled) when unknown. */
  private async keyFor(kid: string): Promise<KeyObject> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    if (Date.now() - this.lastFetchMs >= this.config.minRefreshMs) {
      this.inflight ??= this.refreshKeys().finally(() => {
        this.inflight = undefined;
      });
      await this.inflight;
    }
    const key = this.keys.get(kid);
    if (!key) throw new TokenError('unknown signing key');
    return key;
  }

  private async refreshKeys(): Promise<void> {
    this.lastFetchMs = Date.now();
    let jwksUri = this.config.jwksUri;
    if (!jwksUri) {
      const discoveryUrl =
        this.config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
      const discovery = await fetchJson(discoveryUrl, 'openid discovery');
      // OIDC discovery hygiene: the document must belong to the issuer we
      // were configured to trust.
      if (discovery.issuer !== this.config.issuer) {
        throw new TokenError('discovery document issuer mismatch');
      }
      if (typeof discovery.jwks_uri !== 'string') throw new TokenError('discovery missing jwks_uri');
      jwksUri = discovery.jwks_uri;
    }
    const jwks = await fetchJson(jwksUri, 'jwks');
    const list = Array.isArray(jwks.keys) ? (jwks.keys as Array<Record<string, unknown>>) : [];
    const next = new Map<string, KeyObject>();
    for (const jwk of list) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // One malformed key must not take down the set the issuer also
        // published correctly.
      }
    }
    if (next.size === 0) throw new TokenError('jwks contained no usable RSA keys');
    this.keys = next;
  }
}
