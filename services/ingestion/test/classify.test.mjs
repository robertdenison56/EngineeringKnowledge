import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFilename, deriveTags } from '../dist/classify.js';

test('spec books classify by MasterFormat section number', () => {
  const c = classifyFilename('07 84 00 - Firestopping Master Spec.md');
  assert.equal(c.type, 'spec-section');
  assert.equal(c.anchor?.specSection, '07 84 00');
});

test('drawing sheets classify by sheet number with anchor', () => {
  const c = classifyFilename('A-501 Curtain Wall Sheet Notes.txt');
  assert.equal(c.type, 'document');
  assert.equal(c.anchor?.sheet, 'A-501');
});

test('RFIs and lessons learned classify by keyword', () => {
  assert.equal(classifyFilename('RFI-214 - Firestop substitution.md').type, 'rfi');
  assert.equal(classifyFilename('Lessons - parapet flashing leak.md').type, 'lesson-learned');
});

test('unrecognized files fall back to document', () => {
  assert.equal(classifyFilename('meeting notes.txt').type, 'document');
});

test('parser derives multiple tags from anchors and keywords', () => {
  const sheetClass = classifyFilename('A-501 Curtain Wall Details.pdf');
  assert.deepEqual(deriveTags('A-501 Curtain Wall Details.pdf', '', sheetClass), [
    'architecture',
    'curtain-wall',
  ]);
  const specClass = classifyFilename('07 84 00 - Firestopping.md');
  const tags = deriveTags('07 84 00 - Firestopping.md', 'mineral wool compression', specClass);
  assert.ok(tags.includes('division-07'));
  assert.ok(tags.includes('firestop'));
});
