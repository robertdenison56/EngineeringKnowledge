import { test } from 'node:test';
import assert from 'node:assert/strict';

// The resolver is pure TypeScript with only a type-only @ekg/core import, so it
// loads under Node's native type stripping with no runtime workspace dep.
import { callerFromProxyHeaders, devAuthAllowed, resolveCaller } from '../src/lib/auth.ts';

const DEV_CALLER = { tenantId: 'demo-firm', principals: ['user:dev', 'role:admin', 'role:curator'] };

const OID = 'http://schemas.microsoft.com/identity/claims/objectidentifier';
const TID = 'http://schemas.microsoft.com/identity/claims/tenantid';

/** Encode an Azure "Easy Auth" x-ms-client-principal header from claim pairs. */
function principalHeader(claims) {
  return Buffer.from(JSON.stringify({ claims })).toString('base64');
}

/** A header lookup that only knows the one Easy Auth header. */
function headerGet(value) {
  return (name) => (name === 'x-ms-client-principal' ? value : null);
}

test('no proxy header → null (so the caller can fail closed)', () => {
  assert.equal(callerFromProxyHeaders(headerGet(undefined), {}, 'demo-firm'), null);
});

test('parses an Entra principal: oid → user principal, groups, tenant from tid', () => {
  const header = principalHeader([
    { typ: OID, val: 'abc-123' },
    { typ: 'groups', val: 'g-eng' },
    { typ: 'groups', val: 'g-admins' },
    { typ: TID, val: 'firm-xyz' },
  ]);
  const caller = callerFromProxyHeaders(headerGet(header), { EKG_ADMIN_GROUP: 'g-admins' }, 'demo-firm');
  assert.deepEqual(caller, {
    tenantId: 'firm-xyz',
    principals: ['user:abc-123', 'group:g-eng', 'group:g-admins', 'role:admin'],
  });
});

test('curator group maps to the curator role, not admin', () => {
  const header = principalHeader([
    { typ: OID, val: 'u1' },
    { typ: 'groups', val: 'g-curators' },
  ]);
  const caller = callerFromProxyHeaders(headerGet(header), { EKG_CURATOR_GROUP: 'g-curators' }, 'demo-firm');
  assert.deepEqual(caller.principals, ['user:u1', 'group:g-curators', 'role:curator']);
  assert.ok(!caller.principals.includes('role:admin'));
});

test('a user in no privileged group gets no role principals', () => {
  const header = principalHeader([
    { typ: OID, val: 'u2' },
    { typ: 'groups', val: 'g-random' },
  ]);
  const caller = callerFromProxyHeaders(
    headerGet(header),
    { EKG_ADMIN_GROUP: 'g-admins', EKG_CURATOR_GROUP: 'g-curators' },
    'demo-firm',
  );
  assert.deepEqual(caller.principals, ['user:u2', 'group:g-random']);
});

test('falls back to EKG_TENANT_ID, then the provided fallback, when the proxy omits tid', () => {
  const header = principalHeader([{ typ: OID, val: 'u3' }]);
  assert.equal(
    callerFromProxyHeaders(headerGet(header), { EKG_TENANT_ID: 'pinned' }, 'demo-firm').tenantId,
    'pinned',
  );
  assert.equal(callerFromProxyHeaders(headerGet(header), {}, 'demo-firm').tenantId, 'demo-firm');
});

test('a principal with no usable id → null (fail closed, not an empty user)', () => {
  const header = principalHeader([{ typ: 'groups', val: 'g-eng' }]);
  assert.equal(callerFromProxyHeaders(headerGet(header), {}, 'demo-firm'), null);
});

test('malformed base64 / JSON → null (never throws into the request)', () => {
  assert.equal(callerFromProxyHeaders(headerGet('!!!not-base64-json!!!'), {}, 'demo-firm'), null);
});

test('devAuthAllowed: dev by default, closed in production unless opted in', () => {
  assert.equal(devAuthAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(devAuthAllowed({}), true); // NODE_ENV unset is not production
  assert.equal(devAuthAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(devAuthAllowed({ NODE_ENV: 'production', EKG_DEV_AUTH: '1' }), true);
});

test('resolveCaller: production with no sign-in and no opt-in fails closed (null)', () => {
  assert.equal(resolveCaller(headerGet(undefined), { NODE_ENV: 'production' }, DEV_CALLER), null);
});

test('resolveCaller: local dev with no sign-in falls back to the dev caller', () => {
  assert.deepEqual(resolveCaller(headerGet(undefined), { NODE_ENV: 'development' }, DEV_CALLER), DEV_CALLER);
});

test('resolveCaller: a real proxy identity overrides the dev fallback even in dev', () => {
  const header = principalHeader([{ typ: OID, val: 'real-user' }, { typ: TID, val: 'real-firm' }]);
  const caller = resolveCaller(headerGet(header), { NODE_ENV: 'development' }, DEV_CALLER);
  assert.equal(caller.tenantId, 'real-firm');
  assert.deepEqual(caller.principals, ['user:real-user']);
});
