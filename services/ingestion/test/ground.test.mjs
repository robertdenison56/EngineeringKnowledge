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
