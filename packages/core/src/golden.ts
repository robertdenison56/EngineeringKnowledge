/**
 * Golden retrieval set over the seed corpus (PRD success metric: grounded-
 * answer citation correctness). Every retrieval change must keep this green
 * — `npm run eval` prints the scorecard; the store test suites assert it.
 *
 * `expect: null` cases assert honest no_results behavior (P0-8): the system
 * must say "no answer" rather than return plausible-but-wrong items.
 */
export interface GoldenCase {
  name: string;
  query: string;
  /** Entity id expected within the top `k` results; null = expect zero results. */
  expect: string | null;
  k: number;
}

export const GOLDEN_RETRIEVAL: GoldenCase[] = [
  {
    name: 'exact wording finds the current detail first',
    query: 'curtain wall firestop detail',
    expect: 'detail:cw-firestop-02',
    k: 1,
  },
  {
    name: 'trade synonym (safing) finds the detail',
    query: 'safing at slab edge',
    expect: 'detail:cw-firestop-02',
    k: 3,
  },
  {
    name: 'morphology + synonym (fire stopping spec)',
    query: 'fire stopping spec',
    expect: 'spec:07-84-00',
    k: 3,
  },
  {
    name: 'standards lookup by topic',
    query: 'perimeter fire barrier test standard',
    expect: 'standard:astm-e2307',
    k: 3,
  },
  {
    name: 'natural-language incident question',
    query: 'what failed at the riverside mockup',
    expect: 'lesson:firestop-mockup-failure',
    k: 3,
  },
  {
    name: 'diacritics + expertise lookup',
    query: 'façade fire safety expert',
    expect: 'person:james-okafor',
    k: 3,
  },
  {
    name: 'product lookup',
    query: 'intumescent sealant product',
    expect: 'material:fs-195',
    k: 3,
  },
  {
    name: 'masterformat section, compact form (07 84 00 → 078400)',
    query: 'section 078400',
    expect: 'spec:07-84-00',
    k: 3,
  },
  {
    name: 'masterformat section, dotted form',
    query: '07.84.00 firestopping',
    expect: 'spec:07-84-00',
    k: 3,
  },
  {
    name: 'honest no-results for a section the firm does not have',
    query: 'section 09 91 00',
    expect: null,
    k: 5,
  },
  {
    name: 'honest no-results for absent knowledge',
    query: 'standard parapet coping detail',
    expect: null,
    k: 5,
  },
];
