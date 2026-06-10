import type { Entity, Relationship } from './ontology.js';
import type { GraphStore } from './graph-store.js';

/**
 * Demo corpus for local development and gateway smoke tests. Mirrors the
 * PRD's canonical scenario: a curtain-wall firestop detail with a superseded
 * predecessor, the governing spec section and standard, a lesson learned,
 * and the firm's expert — plus one ACL-restricted document to exercise
 * permission trimming.
 */
export const DEMO_TENANT = 'demo-firm';

const NOW = '2026-06-09T00:00:00Z';

function entity(partial: Omit<Entity, 'tenantId' | 'provenance'> & {
  provenance?: Partial<Entity['provenance']>;
}): Entity {
  return {
    ...partial,
    tenantId: DEMO_TENANT,
    provenance: {
      createdAt: NOW,
      modifiedAt: NOW,
      reviewStatus: 'verified',
      ...partial.provenance,
    },
  };
}

function rel(id: string, type: Relationship['type'], fromId: string, toId: string): Relationship {
  return { id, tenantId: DEMO_TENANT, type, fromId, toId };
}

const PUBLIC = { allowedPrincipals: ['*'] };

export const DEMO_ENTITIES: Entity[] = [
  entity({
    id: 'project:riverside',
    type: 'project',
    title: 'Riverside Medical Center',
    summary: 'Six-story acute-care hospital, completed 2024. Steel frame, unitized curtain wall.',
    properties: { client: 'Meridian Health', completedYear: 2024, market: 'healthcare' },
    acl: PUBLIC,
  }),
  entity({
    id: 'detail:cw-firestop-02',
    type: 'design-detail',
    title: 'Curtain wall to slab edge firestop detail (rev. 2)',
    summary:
      'Perimeter fire barrier at unitized curtain wall: 4 pcf mineral wool, 25% compression, with smoke sealant over galvanized backer.',
    properties: { discipline: 'architecture', system: 'curtain wall' },
    provenance: {
      sourceUrl: 'https://demo-firm.sharepoint.com/details/cw-firestop-02.pdf',
      author: 'James Okafor',
      anchor: { sheet: 'A-501', page: 12 },
    },
    acl: PUBLIC,
  }),
  entity({
    id: 'detail:cw-firestop-01',
    type: 'design-detail',
    title: 'Curtain wall to slab edge firestop detail (rev. 1)',
    summary: 'Original perimeter fire barrier detail. Failed hose-stream test in 2023 mockup.',
    properties: { discipline: 'architecture', system: 'curtain wall' },
    provenance: {
      sourceUrl: 'https://demo-firm.sharepoint.com/details/cw-firestop-01.pdf',
      author: 'James Okafor',
      reviewStatus: 'superseded',
      anchor: { sheet: 'A-501', page: 12 },
    },
    acl: PUBLIC,
  }),
  entity({
    id: 'spec:07-84-00',
    type: 'spec-section',
    title: 'Section 07 84 00 — Firestopping',
    summary: 'Firm master spec for through-penetration and perimeter firestopping systems.',
    properties: { masterformat: '07 84 00' },
    provenance: {
      sourceUrl: 'https://demo-firm.sharepoint.com/specs/master/07-84-00.pdf',
      anchor: { specSection: '07 84 00' },
    },
    acl: PUBLIC,
  }),
  entity({
    id: 'standard:astm-e2307',
    type: 'standard',
    title: 'ASTM E2307 — Perimeter Fire Barrier Systems',
    summary: 'Test standard for fire resistance of perimeter fire barriers using the intermediate-scale multistory apparatus.',
    properties: { body: 'ASTM' },
    acl: PUBLIC,
  }),
  entity({
    id: 'lesson:firestop-mockup-failure',
    type: 'lesson-learned',
    title: 'Perimeter fire barrier failed hose-stream test at mockup',
    summary:
      'Rev. 1 firestop detail failed the 2023 Riverside mockup: mineral wool was cut flush and lost compression at deflection. Root cause: no compression spec on the drawing. Fix: specify 25% compression and reinforce at mullions (rev. 2).',
    properties: { rootCause: 'missing compression requirement', costImpact: 'mockup re-test, 3-week delay' },
    provenance: { author: 'James Okafor' },
    acl: PUBLIC,
  }),
  entity({
    id: 'person:james-okafor',
    type: 'person',
    title: 'James Okafor',
    summary: 'Senior façade engineer; firm expert on curtain wall fire/life-safety interfaces.',
    properties: { discipline: 'facade engineering' },
    acl: PUBLIC,
  }),
  entity({
    id: 'document:claims-memo-riverside',
    type: 'document',
    title: 'Riverside firestop claim — legal memo',
    summary: 'Privileged memo on the mockup-failure schedule claim.',
    properties: {},
    provenance: { author: 'Outside counsel' },
    acl: { allowedPrincipals: ['group:legal'] },
  }),
];

export const DEMO_RELATIONSHIPS: Relationship[] = [
  rel('rel:1', 'used-in', 'detail:cw-firestop-02', 'project:riverside'),
  rel('rel:2', 'supersedes', 'detail:cw-firestop-02', 'detail:cw-firestop-01'),
  rel('rel:3', 'authored-by', 'detail:cw-firestop-02', 'person:james-okafor'),
  rel('rel:4', 'complies-with', 'detail:cw-firestop-02', 'standard:astm-e2307'),
  rel('rel:5', 'applies-to', 'lesson:firestop-mockup-failure', 'detail:cw-firestop-01'),
  rel('rel:6', 'had-issue', 'project:riverside', 'lesson:firestop-mockup-failure'),
  rel('rel:7', 'applies-to', 'spec:07-84-00', 'project:riverside'),
];

export async function seedDemo(store: GraphStore): Promise<void> {
  for (const e of DEMO_ENTITIES) await store.upsertEntity(e);
  for (const r of DEMO_RELATIONSHIPS) await store.upsertRelationship(r);
}
