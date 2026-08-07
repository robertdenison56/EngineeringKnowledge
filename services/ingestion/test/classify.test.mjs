import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFilename,
  deriveTags,
  parseSpecSection,
  parseSpecSectionHeading,
} from '../dist/classify.js';

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

test('a revision date is not a MasterFormat section', () => {
  // The header on every page of the Caltrans standard specifications. It
  // anchored 134 of 140 chunks to the fictional section "04 15 22" — a wrong
  // citation, which is the one defect class provenance cannot survive.
  assert.equal(parseSpecSection('REVISED STANDARD SPECIFICATIONS DATED 04-15-22'), undefined);
  for (const dated of [
    'Issued 12-31-24',
    'Rev. 03-01-25 by JD',
    'drawing log 04.15.22',
    'Effective 01-01-26',
    '04-15-22', // bare and uncued: shape alone has to carry it
    'DATED 15-04-22', // day-first is only caught by the cue (see classify.ts)
  ]) {
    assert.equal(parseSpecSection(dated), undefined, dated);
  }
});

test('a drawing-title "SECTION" does not vouch for the date after it', () => {
  // "SECTION" is a view title at least as often as a spec reference on civil
  // sheets, so shape has to outrank the cue — otherwise the cue becomes an
  // escape hatch that reopens exactly the citation this guards against.
  for (const title of [
    'TYPICAL CROSS SECTION 06-30-24',
    'SUBSECTION 04-15-22',
    'INTERSECTION 04-15-22 IMPROVEMENTS',
  ]) {
    assert.equal(parseSpecSection(title), undefined, title);
  }
});

test('cues bind to the adjacent word on the same line, not a substring', () => {
  // "UPDATED" ends in "DATED" and "CONSOLIDATED" in "DATED"; neither is a date
  // context, and a substring test silently deleted both sections.
  assert.equal(parseSpecSection('UPDATED 07 84 00 FIRESTOPPING'), '07 84 00');
  assert.equal(parseSpecSection('CONSOLIDATED 07 84 00'), '07 84 00');
  assert.equal(parseSpecSection('The candidate 07 84 00 spec'), '07 84 00');
  // PDF extraction flattens a cover sheet into one string, so a noun on the
  // line above must neither veto nor vouch.
  assert.equal(parseSpecSection('Bid date\n07 84 00 FIRESTOPPING'), '07 84 00');
  assert.equal(parseSpecSection('BUILDING SECTION\n04-15-22'), undefined);
});

test('real section codes still parse, in every spelling', () => {
  assert.equal(parseSpecSection('SECTION 07 84 00 - FIRESTOPPING'), '07 84 00');
  assert.equal(parseSpecSection('07 84 00 Firestopping'), '07 84 00');
  // Dashes are a legal spelling, and 84 is no calendar day, so it is no date.
  assert.equal(parseSpecSection('07-84-00 firestop'), '07 84 00');
  // A level-2 section ends in 00, which no live year does — the signal that
  // keeps dash-spelled sections in divisions 01–12 from reading as dates.
  assert.equal(parseSpecSection('07-21-00 Thermal Insulation.pdf'), '07 21 00');
  assert.equal(parseSpecSection('03-30-00 Cast-in-Place Concrete.pdf'), '03 30 00');
  assert.equal(parseSpecSection('Spec 07.21.00 Insulation'), '07 21 00');
  assert.equal(classifyFilename('07-21-00 Thermal Insulation.pdf').type, 'spec-section');
  assert.equal(parseSpecSection('09 91 23.13 Interior Painting'), '09 91 23');
  assert.equal(parseSpecSection('Division 26 05 00 Common Work Results'), '26 05 00');
  // A digit earlier on the line does not make the code part of a longer run…
  assert.equal(parseSpecSection('Volume 2 07 84 00'), '07 84 00');
  assert.equal(parseSpecSection('PART 2 07 84 00 PRODUCTS'), '07 84 00');
  // …but a dot or dash after one does: that is outline numbering.
  assert.equal(parseSpecSection('1.2.07.84.00 outline'), undefined);
  assert.equal(parseSpecSection('invoice 12345678'), undefined);
  assert.equal(parseSpecSection('2024 06 24 progress set'), undefined);
});

test('scanning past a date finds the section a header buries', () => {
  // Only the first candidate used to be considered, so a date in front of a
  // real section discarded the section along with itself.
  assert.equal(
    parseSpecSection('Revised 06-30-24 — 22 05 00 Common Work Results for Plumbing'),
    '22 05 00',
  );
  assert.equal(parseSpecSection('DATED 04-15-22  SECTION 07 92 00 JOINT SEALANTS'), '07 92 00');
  // The canonical space spelling is never read as a date, so a cue can vouch
  // for a section that happens to read like one.
  assert.equal(parseSpecSection('SECTION 04 15 22'), '04 15 22');
});

test('a compact MMDDYY date stamp is not a MasterFormat section', () => {
  // Found ingesting the Caltrans Highway Design Manual: six chapter files are
  // stamped with their revision date, "chp0060 092923-a11y.pdf". Read as a
  // section that made every one of the six a `spec-section` and stamped
  // "09 29 23" on all 280 of their passages — the single largest source of
  // false citations in the corpus, from one date written six times.
  for (const stamped of [
    'chp0060 092923-a11y.pdf',
    'chp0200 092923-a11y.pdf',
    '092923 design bulletin.pdf',
    'meeting notes 043022.docx',
  ]) {
    assert.equal(parseSpecSection(stamped), undefined, stamped);
    assert.equal(classifyFilename(stamped).type, 'document', stamped);
  }
  // The escapes that keep compact REAL sections readable: a level-2 code ends
  // in "00", and a level-3 middle group is usually no calendar day.
  assert.equal(parseSpecSection('078400 Firestopping.pdf'), '07 84 00');
  assert.equal(parseSpecSection('074213 Metal Wall Panels'), '07 42 13');
});

test('a page heading will not read a section out of a table of numbers', () => {
  // Every one of these is a real page opening from the Caltrans corpus, and
  // every one produced a false citation under the permissive scan.
  for (const header of [
    'Chart No. K2 Conventional Highway Lane Requirements Hour 00 01 02 03 04 05 06',
    'Conductor no. 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16',
    'BID ITEM LIST Item Item Code Item Description No. 0001 070030 LEAD COMPLIANCE PLAN',
    'Item Item Code Item Description No. 0061 397005 TACK COAT',
    '3CSC 3 no. 14 44 36 5CSC 5 no. 14 44 36 9CSC 1 no. 12',
    'Table 202.2A Minimum Radii V d (mph) 20 25 30 35 40 45 50',
    'Dist COUNTY ROUTE POST MILES SHEET TOTAL 34 34 34',
  ]) {
    assert.equal(parseSpecSectionHeading(header), undefined, header);
  }
});

test('a page heading still reads the two forms a spec book actually uses', () => {
  // Labeled anywhere in the header…
  assert.equal(parseSpecSectionHeading('REVISED 06-30-24\nSECTION 07 84 00 - FIRESTOPPING'), '07 84 00');
  assert.equal(parseSpecSectionHeading('DIVISION 26 05 00 Common Work Results'), '26 05 00');
  // …or opening the page with its title after it, which is the running header.
  assert.equal(parseSpecSectionHeading('07 92 00 JOINT SEALANTS. Backer rod shall be'), '07 92 00');
  assert.equal(parseSpecSectionHeading('07 84 00 — Firestopping (continued)'), '07 84 00');
  // Opening the page but followed by more numbers is a table, not a heading.
  assert.equal(parseSpecSectionHeading('07 84 00 15 20 25 30'), undefined);
  // Buried in the header, even with a title after it: not evidence. A bid item
  // code reads exactly like a section followed by its title.
  assert.equal(parseSpecSectionHeading('Item No. 0001 070030 LEAD COMPLIANCE PLAN'), undefined);
  // The permissive scan is unchanged for filenames — one deliberate human act.
  assert.equal(parseSpecSection('The candidate 07 84 00 spec'), '07 84 00');
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

test('a commodity material does not imply the trade that often uses it', () => {
  // "mineral wool" mapped to the firestop tag, which tagged 7 of 29 Caltrans
  // highway specs as firestop knowledge — the phrase occurs only in the Buy
  // Clean California Act clause ("mineral wool board insulation" needs an
  // environmental product declaration). The false tag then matched the
  // "firestop" concept in search, so a highway spec surfaced as a partial
  // answer to a curtain-wall firestop question: a bad tag laundering into a
  // bad retrieval hit.
  const doc = classifyFilename('03-3H5404sp.pdf');
  const tags = deriveTags(
    '03-3H5404sp.pdf',
    'Environmental product declarations for structural steel, flat glass, or mineral wool board insulation',
    doc,
  );
  assert.ok(!tags.includes('firestop'), `firestop tagged from mineral wool: ${tags}`);
});
