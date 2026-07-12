import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProjectCsv, buildProjectCandidates } from '../dist/index.js';

test('parseProjectCsv maps header synonyms by name, not position', () => {
  const csv = [
    'Project Name,Project Number,Client,Discipline,Status',
    'Riverside Transit Center,2024-118,Metro Authority,Structural,Construction',
    'Hilltop Library,2025-006,City of Ashford,Architectural,Design',
  ].join('\n');
  const { rows, errors, recognized, ignored } = parseProjectCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(ignored.length, 0);
  assert.ok(recognized.includes('Project Name') && recognized.includes('Client'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    name: 'Riverside Transit Center',
    number: '2024-118',
    client: 'Metro Authority',
    discipline: 'Structural',
    status: 'Construction',
    line: 2,
  });
});

test('parseProjectCsv handles quoted fields with embedded commas, quotes, and newlines', () => {
  const csv =
    'name,description\n' +
    '"Pier 7, Phase II","Includes a ""floating"" deck\nand a seawall"\n';
  const { rows, errors } = parseProjectCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Pier 7, Phase II');
  assert.equal(rows[0].description, 'Includes a "floating" deck\nand a seawall');
});

test('parseProjectCsv reports a missing-name row and keeps the rest (never guesses)', () => {
  const csv = ['name,client', 'Good Project,Acme', ',Orphan Client', 'Also Good,Beta'].join('\n');
  const { rows, errors } = parseProjectCsv(csv);
  assert.deepEqual(rows.map((r) => r.name), ['Good Project', 'Also Good']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /missing project name/);
});

test('parseProjectCsv errors clearly when no name column is present', () => {
  const { rows, errors } = parseProjectCsv('client,status\nAcme,Active');
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no project-name column/);
});

test('parseProjectCsv splits tags on ; , | and auto-detects a tab-delimited export', () => {
  const tsv = 'name\ttags\nNorth Span\trail; seismic | qa';
  const { rows } = parseProjectCsv(tsv);
  assert.deepEqual(rows[0].tags, ['rail', 'seismic', 'qa']);
});

test('parseProjectCsv tolerates a BOM, CRLF line endings, and blank lines', () => {
  const csv = '﻿name,client\r\nAlpha,Acme\r\n\r\nBeta,Beta Co\r\n';
  const { rows, errors } = parseProjectCsv(csv);
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => r.name), ['Alpha', 'Beta']);
});

test('buildProjectCandidates makes unverified project entities with stable, number-keyed ids', () => {
  const { rows } = parseProjectCsv('name,number,discipline\nRiverside Transit Center,2024-118,Structural');
  const [c] = buildProjectCandidates(rows, { tenantId: 'demo-firm', now: '2026-06-24T00:00:00.000Z' });
  assert.equal(c.entity.type, 'project');
  assert.equal(c.entity.title, 'Riverside Transit Center');
  assert.equal(c.entity.properties.projectNumber, '2024-118');
  assert.equal(c.entity.properties.pipeline, 'csv-project-import');
  assert.ok(c.entity.tags.includes('structural'), 'discipline becomes a tag');
  assert.equal(c.entity.provenance.reviewStatus, 'unverified');
  assert.equal(c.entity.provenance.sourceSystem, 'csv');

  // Re-importing the same project (by number) yields the same id → an update,
  // not a duplicate; a different number yields a different id.
  const [again] = buildProjectCandidates(
    parseProjectCsv('name,number\nRiverside Transit Center (renamed),2024-118').rows,
    { tenantId: 'demo-firm' },
  );
  assert.equal(again.entity.id, c.entity.id, 'same number ⇒ same id');
  const [other] = buildProjectCandidates(parseProjectCsv('name,number\nX,2024-119').rows, {
    tenantId: 'demo-firm',
  });
  assert.notEqual(other.entity.id, c.entity.id);
});

test('buildProjectCandidates captures a restricted ACL and source link from the import', () => {
  const { rows } = parseProjectCsv('name,url\nClassified Hangar,https://firm.sharepoint.com/p/hangar');
  const [c] = buildProjectCandidates(rows, {
    tenantId: 'demo-firm',
    source: { system: 'csv', acl: { allowedPrincipals: ['group:federal'] } },
  });
  assert.deepEqual(c.entity.acl.allowedPrincipals, ['group:federal']);
  // A per-row URL beats the batch source url.
  assert.equal(c.entity.provenance.sourceUrl, 'https://firm.sharepoint.com/p/hangar');
});
