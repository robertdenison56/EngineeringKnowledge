# ADR 0011: OAuth 2.1 + Entra federation on the gateway

Date: 2026-06-24 · Status: Proposed

## Context

The remote gateway ships today with per-request identity from a **bearer JWT**
(HS256, `EKG_JWT_SECRET`) whose claims `{ tid, sub, groups }` resolve to a
`Caller` and drive ACL trimming + tenant isolation + audit ([ADR 0001](./0001-initial-tech-stack.md),
`apps/mcp-server/src/auth.ts`). That was the deliberate Phase-2 slice: ship
remote + dev-token first, **defer full OAuth**.

The deferral now has a concrete cost. An **admin-managed claude.ai organization
connector** — the path an Owner adds once for the whole firm — is **OAuth-based**:
claude.ai runs an OAuth authorization handshake against the server and has *no
field for a static bearer token*. The MCP authorization spec requires the server,
as an OAuth **Resource Server**, to advertise where to get a token and to verify
the tokens it receives. The gateway exposes no OAuth metadata and verifies only
its own shared-secret HS256 tokens, so claude.ai (and M365 Copilot, same story)
cannot connect. Clients that send a static `Authorization` header — Claude Code
remote, the API MCP connector, ChatGPT — work today; the org connectors do not.

The good news, baked in since ADR 0001: the dev JWT uses **the same claim shape**
a federated Entra token carries, so this is a **verifier swap**, not a rebuild.

## Decisions

- **The gateway is an OAuth 2.1 Resource Server only — it never mints tokens.**
  Microsoft Entra ID is the authorization server (it owns `/authorize`, `/token`,
  consent, and key rotation). We add exactly two things: a metadata route and a
  real token verifier. Everything downstream of `resolveCallerFromAuth` is
  untouched.

- **Advertise protected-resource metadata (RFC 9728).** Serve
  `GET /.well-known/oauth-protected-resource` returning the gateway's resource
  identifier (the audience tokens must carry) and `authorization_servers`
  pointing at the firm's Entra tenant. On a missing/invalid token, the `401`
  carries `WWW-Authenticate: Bearer resource_metadata="<that URL>"` so a client
  discovers the auth server without out-of-band config. (The gateway already
  returns `WWW-Authenticate: Bearer` — this enriches it.) We do **not** implement
  Dynamic Client Registration; claude.ai's "custom credentials for non-DCR
  servers" lets the Owner paste the Entra app's **Client ID/Secret** in the
  connector's Advanced settings.

- **`verifyToken` becomes an RS256/JWKS check; nothing else moves.** Validate the
  Entra-signed JWT against the tenant's published JWKS (`openid-configuration` →
  `jwks_uri`, cached with rotation), asserting `iss` = the Entra tenant, `aud` =
  our resource identifier, and `exp` (already enforced). Map Entra claims onto
  `EkgClaims`: `tid` ← the Entra tenant id, `sub` ← the user object id (or `oid`),
  `groups` ← the Entra group object ids. `resolveCallerFromAuth` and every ACL /
  tenant / audit consumer stay **byte-for-byte the same** — that was the point of
  matching the claim shape.

- **Two verifiers, selected by config — keep the dev path.** Default stays the
  HS256 dev-secret verifier (local dev, CI smoke tests, getting-started all keep
  working with `EKG_JWT_SECRET`). Setting `EKG_OIDC_ISSUER` + `EKG_OIDC_AUDIENCE`
  (+ optional `EKG_OIDC_JWKS_URI`) switches production to the OIDC verifier. One
  seam, two implementations, chosen at startup — never both live for one request.

- **Deploy prerequisite: one Entra app registration for the gateway-as-API.**
  Expose a scope (e.g. `mcp.invoke`), set the Application ID URI as the resource
  identifier, and configure the **groups claim** so `groups` is populated. The
  Owner wires that app's Client ID/Secret into the claude.ai org connector;
  members sign in through Entra, consent once, and claude.ai obtains a token
  audienced to the gateway. M365 Copilot rides the same registration.

- **Out of scope here.** The *workspace app's* own login/SSO and role gating
  (gaps-vs-prd **G11**) is a separate front-end concern — this ADR is the gateway
  resource-server seam only. Per-tool OAuth scopes beyond resource-level access,
  and an OAuth-aware mode for the [sign-off script], are follow-ons.

[sign-off script]: ../guides/05-admin-guide.md#end-to-end-sign-off

## Consequences

- The **admin-managed claude.ai org connector becomes connectable** (and M365
  Copilot with it), with no change to how knowledge is trimmed or audited — the
  honest "designed, not built" notes in the admin guide become "built."
- **Low blast radius, as promised:** the diff is a metadata route + a second
  `verifyToken` implementation. ACL trimming, tenant isolation, the audit
  boundary, and the whole tool surface are unchanged, so the existing proofs
  (`smoke-http.mjs`, `signoff-remote.mjs`) still hold for the dev path.
- **New operational surface:** JWKS fetch/caching and clock-skew tolerance, key
  rotation handling, and an Entra app registration as a deploy step. These are
  standard resource-server concerns but are new to this codebase.
- **Honest limits:** Entra **group-claim overage** — past ~200 groups Entra omits
  `groups` and returns a Graph pointer instead; until a Graph-backed expansion
  lands, a user over the limit would resolve with empty `principals` and see only
  tenant-public (`*`) items (fails *closed*, not open — acceptable, but noted).
  The dev-secret HS256 path remains available and must stay locked down (short
  token lifetimes, real secret management) wherever it's still used.
- The [sign-off script] will need an OAuth mode (client-credentials grant or a
  real Entra token) to exercise a production deployment end-to-end; until then it
  validates the dev-token path and the universal contract.
