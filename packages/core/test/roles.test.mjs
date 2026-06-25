import test from 'node:test';
import assert from 'node:assert/strict';
import {
  entityMatchesRole,
  roleBoostFactor,
  parseRoles,
  serializeRoles,
  findRole,
  SUGGESTED_ROLES,
} from '../dist/index.js';

const ROLE = {
  id: 'fire',
  name: 'Fire Safety',
  boostTags: ['firestop'],
  boostTypes: ['lesson-learned'],
  weight: 2,
};

function ent(partial) {
  return {
    id: 'x',
    tenantId: 't',
    type: 'document',
    title: 'x',
    properties: {},
    provenance: { createdAt: '', modifiedAt: '', reviewStatus: 'verified' },
    acl: { allowedPrincipals: ['*'] },
    ...partial,
  };
}

test('entityMatchesRole: matches on boost tag OR boost type, nothing else', () => {
  assert.equal(entityMatchesRole(ent({ tags: ['firestop'] }), ROLE), true);
  assert.equal(entityMatchesRole(ent({ type: 'lesson-learned' }), ROLE), true);
  assert.equal(entityMatchesRole(ent({ type: 'document', tags: ['other'] }), ROLE), false);
  assert.equal(entityMatchesRole(ent({}), ROLE), false);
});

test('roleBoostFactor: role weight on a match, 1 otherwise', () => {
  assert.equal(roleBoostFactor(ent({ tags: ['firestop'] }), ROLE), 2);
  assert.equal(roleBoostFactor(ent({ tags: ['unrelated'] }), ROLE), 1);
  assert.equal(roleBoostFactor(ent({ tags: ['firestop'] }), undefined), 1, 'no role → no boost');
});

test('parseRoles tolerates missing and malformed config, dropping bad elements', () => {
  assert.deepEqual(parseRoles(undefined), []);
  assert.deepEqual(parseRoles(''), []);
  assert.deepEqual(parseRoles('not json at all'), []);
  assert.deepEqual(parseRoles('{"not":"an array"}'), []);
  const mixed = JSON.stringify([
    { id: 'a', name: 'A', boostTags: [], boostTypes: ['document'], weight: 1.5 },
    { bad: true },
    { id: 'b', name: 'B', boostTags: ['x'], boostTypes: [], weight: 2 },
  ]);
  const roles = parseRoles(mixed);
  assert.deepEqual(roles.map((r) => r.id), ['a', 'b'], 'keeps well-formed, drops malformed');
});

test('serialize/parse round-trips the suggested roles', () => {
  const roundtrip = parseRoles(serializeRoles(SUGGESTED_ROLES));
  assert.equal(roundtrip.length, SUGGESTED_ROLES.length);
  assert.deepEqual(roundtrip[0], SUGGESTED_ROLES[0]);
});

test('findRole resolves by id or case-insensitive name', () => {
  assert.equal(findRole(SUGGESTED_ROLES, 'project-delivery')?.id, 'project-delivery');
  assert.equal(findRole(SUGGESTED_ROLES, 'Project Delivery')?.id, 'project-delivery');
  assert.equal(findRole(SUGGESTED_ROLES, undefined), undefined);
  assert.equal(findRole(SUGGESTED_ROLES, 'no such role'), undefined);
});
