import type { Caller } from '@ekg/core';

/**
 * Per-request identity for the workspace app (PRD P0-7, P0-9).
 *
 * The app runs behind an identity proxy — Azure App Service Authentication
 * ("Easy Auth") fronting Entra ID, or any reverse proxy that validates the
 * sign-in and forwards the authenticated principal as request headers. The
 * platform verifies the token; the app trusts the proxy and holds no
 * token-signing secret of its own. This replaces the former hard-coded
 * all-powerful `DEV_CALLER` that ran every request as an admin + curator: when
 * no authenticated principal is present, {@link resolveCaller} fails closed in
 * production and only falls back to a fixed dev identity in local development.
 *
 * The header parsing here is a pure function of `(headerGet, env)` so it can be
 * reasoned about and tested without a live request.
 */

/** Role principals mirror the constants in `store.ts` (kept literal to avoid a cycle). */
const ADMIN_PRINCIPAL = 'role:admin';
const CURATOR_PRINCIPAL = 'role:curator';

/** Header lookup, abstracted so the resolver needs no `next/headers` binding. */
export type HeaderGet = (name: string) => string | null | undefined;

/** The slice of the environment that shapes identity resolution. */
export interface AuthEnv {
  EKG_DEV_AUTH?: string;
  NODE_ENV?: string;
  /** Single-tenant deployments pin the tenant id here when the proxy omits it. */
  EKG_TENANT_ID?: string;
  /** Comma-separated Entra group object-ids that map to the admin role. */
  EKG_ADMIN_GROUP?: string;
  /** Comma-separated Entra group object-ids that map to the curator role. */
  EKG_CURATOR_GROUP?: string;
}

function groupSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

interface MsClientPrincipal {
  claims?: { typ: string; val: string }[];
}

/**
 * Derive the caller from the Azure App Service / Entra "Easy Auth"
 * `x-ms-client-principal` header — a base64-encoded JSON blob of validated
 * claims. Returns null when the header is absent or unparseable, so the request
 * fails closed rather than defaulting to an unscoped or privileged identity.
 */
export function callerFromProxyHeaders(
  get: HeaderGet,
  env: AuthEnv,
  fallbackTenant: string,
): Caller | null {
  const raw = get('x-ms-client-principal');
  if (!raw) return null;

  let decoded: MsClientPrincipal;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as MsClientPrincipal;
  } catch {
    return null;
  }
  const claims = decoded.claims ?? [];
  const find = (...types: string[]): string | undefined =>
    claims.find((c) => types.includes(c.typ))?.val;

  // Entra object-id is the stable principal; fall back to UPN / preferred name.
  const oid = find('http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid');
  const upn = find(
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
    'preferred_username',
    'name',
  );
  const id = oid ?? upn;
  if (!id) return null;

  const groups = claims
    .filter(
      (c) =>
        c.typ === 'groups' ||
        c.typ === 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
    )
    .map((c) => c.val);

  const adminGroups = groupSet(env.EKG_ADMIN_GROUP);
  const curatorGroups = groupSet(env.EKG_CURATOR_GROUP);
  const roles: string[] = [];
  if (groups.some((g) => adminGroups.has(g))) roles.push(ADMIN_PRINCIPAL);
  if (groups.some((g) => curatorGroups.has(g))) roles.push(CURATOR_PRINCIPAL);

  const tenantId =
    find('http://schemas.microsoft.com/identity/claims/tenantid', 'tid') ??
    env.EKG_TENANT_ID ??
    fallbackTenant;

  return {
    tenantId,
    principals: [`user:${id}`, ...groups.map((g) => `group:${g}`), ...roles],
  };
}

/**
 * True when a fixed dev identity may stand in for real SSO — local development,
 * or an explicit `EKG_DEV_AUTH=1` opt-in. A production build with neither set
 * has no dev fallback, so an unauthenticated request is rejected.
 */
export function devAuthAllowed(env: AuthEnv): boolean {
  return env.EKG_DEV_AUTH === '1' || env.NODE_ENV !== 'production';
}

/**
 * Resolve the calling identity for a request, or null when it should fail
 * closed. `devCaller` is returned only when {@link devAuthAllowed}. Pure: all
 * inputs are explicit, so this is the unit-testable core of {@link getCaller}.
 */
export function resolveCaller(
  get: HeaderGet,
  env: AuthEnv,
  devCaller: Caller,
): Caller | null {
  const fromProxy = callerFromProxyHeaders(get, env, devCaller.tenantId);
  if (fromProxy) return fromProxy;
  return devAuthAllowed(env) ? devCaller : null;
}
