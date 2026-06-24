import test from 'node:test';
import assert from 'node:assert/strict';
import { groundAnnotations } from '../dist/ground.js';

const TEXT_LAYER =
  'SECTION 07 92 00 - JOINT SEALANTS Single-component neutral-cure silicone: ' +
  'ASTM C920, Type S, Grade NS, Class 50. #4 Bar @ 12" Centers 1\'-6" curtain wall perimeter';

test('verbatim annotations ground against the text layer', () => {
  const report = groundAnnotations(['ASTM C920', 'curtain wall perimeter'], TEXT_LAYER);
  assert.equal(report.groundable, true);
  assert.deepEqual(report.grounded, ['ASTM C920', 'curtain wall perimeter']);
  assert.deepEqual(report.ungrounded, []);
});

test('grounding tolerates formatting noise but not fabrication', () => {
  const report = groundAnnotations(
    ['#4 bar @ 12" centers', `1'-6"`, 'ASTM E2307', 'Grade XX'],
    TEXT_LAYER,
  );
  assert.deepEqual(report.grounded, ['#4 bar @ 12" centers', `1'-6"`]);
  assert.deepEqual(report.ungrounded, ['ASTM E2307', 'Grade XX']);
});

test('scans (no text layer) are not groundable — everything flagged', () => {
  const report = groundAnnotations(['Endwall', 'Keyway'], undefined);
  assert.equal(report.groundable, false);
  assert.deepEqual(report.grounded, []);
  assert.deepEqual(report.ungrounded, ['Endwall', 'Keyway']);
});

test('partial-word matches do not count as grounded', () => {
  const report = groundAnnotations(['ASTM C92'], TEXT_LAYER);
  assert.deepEqual(report.ungrounded, ['ASTM C92']);
});

test('letter-spaced CAD text grounds space-blind, on token boundaries only', () => {
  // Caltrans text layers extract "ROUTE 505" as "R OU TE 505".
  const report = groundAnnotations(
    ['ROUTE 505', 'CURVE DATA', 'ROUTE 50'],
    'R OU TE 505 ... C U RVE DA TA table',
  );
  assert.deepEqual(report.grounded, ['ROUTE 505', 'CURVE DATA']);
  // "ROUTE 50" ends mid-token (inside 505) — not grounded.
  assert.deepEqual(report.ungrounded, ['ROUTE 50']);
});

// --- Grounding v2: parser facts as a second source (ADR 0008) --------------

test('parser facts reclaim a dimension the text layer mangled', () => {
  // The text layer scrambles the dimension, but the geometry parser found
  // "18'-11\"" — and the model quoted it with descriptive words appended.
  const facts = { dimensions: [`18'-11"`, `71'-0"`], views: ['ELEVATION'] };
  const report = groundAnnotations(
    [`18'-11"± AFTER STRENGTHEN`, `71'-0"± LEFT BRIDGE`, 'ELEVATION'],
    'unrelated text with no dimensions',
    facts,
  );
  assert.deepEqual(report.grounded, [`18'-11"± AFTER STRENGTHEN`, `71'-0"± LEFT BRIDGE`, 'ELEVATION']);
  assert.deepEqual(report.ungrounded, []);
  assert.equal(report.parserConfirmed.length, 3, 'all three confirmed by the parser');
});

test('parserConfirmed marks two-source agreement even when text also grounds', () => {
  const facts = { dimensions: [`12'-6"`] };
  const report = groundAnnotations([`12'-6"`, 'random note'], `the wall is 12'-6" tall`, facts);
  assert.ok(report.grounded.includes(`12'-6"`));
  assert.deepEqual(report.parserConfirmed, [`12'-6"`]);
  assert.deepEqual(report.ungrounded, ['random note']);
});

test('parser grounding does not admit fabrications or numeric fragments', () => {
  const facts = { dimensions: [`8'-0"`, `48'-0"`], views: ['PLAN'] };
  const report = groundAnnotations(
    ['ZZ-NOT-ON-SHEET', '8', `99'-9"`],
    'plain text',
    facts,
  );
  // "8" is too unspecific to confirm against "8'-0\""; the others aren't facts.
  assert.deepEqual(report.grounded, []);
  assert.equal(report.parserConfirmed.length, 0);
});

test('facts alone make a scan groundable (no text layer)', () => {
  const facts = { sheetNumber: 'S-101', views: ['SECTION A-A'] };
  const report = groundAnnotations(['SECTION A-A', 'illegible note'], undefined, facts);
  assert.equal(report.groundable, true);
  assert.deepEqual(report.grounded, ['SECTION A-A']);
  assert.deepEqual(report.parserConfirmed, ['SECTION A-A']);
});
