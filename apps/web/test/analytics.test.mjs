import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure aggregations with only type-only @ekg/core imports, so they load under
// Node's native type stripping with no runtime workspace dep.
import { analyzeUsage, citationCounts, parseAuditJsonl } from '../src/lib/analytics.ts';

/** Minimal audit event — only the fields the aggregations read. */
function event({
  ts = '2026-07-19T10:00:00.000Z',
  tenantId = 'demo-firm',
  principal = 'user:dev',
  tool = 'search',
  transport = 'stdio',
  args,
  resultIds,
  outcome = 'ok',
} = {}) {
  return { ts, tenantId, principal, tool, transport, args, resultIds, outcome };
}

test('parseAuditJsonl skips torn and foreign lines instead of failing the trail', () => {
  const text = [
    JSON.stringify(event({})),
    '{"ts":"2026-07-19T10:01:00Z","tenantId":"demo-firm","tool":"fetch"', // torn write
    'not json at all',
    JSON.stringify({ some: 'other shape' }), // foreign object, no ts/tenant/tool
    JSON.stringify(event({ tool: 'fetch' })),
    '',
  ].join('\n');
  const events = parseAuditJsonl(text);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.tool),
    ['search', 'fetch'],
  );
});

test('analyzeUsage scopes to the tenant and counts surfaces, tools, users', () => {
  const events = [
    event({ principal: 'user:priya', transport: 'stdio' }),
    event({ ts: '2026-07-19T11:00:00.000Z', principal: 'user:priya', transport: 'http', tool: 'fetch' }),
    event({ ts: '2026-07-19T12:00:00.000Z', principal: 'user:marcus', transport: 'web', tool: 'verify_entity' }),
    event({ tenantId: 'other-firm', principal: 'user:rival' }), // must not leak in
    event({ ts: '2026-07-19T13:00:00.000Z', principal: 'user:priya', transport: 'stdio', outcome: 'error' }),
  ];
  const usage = analyzeUsage(events, { tenantId: 'demo-firm' });
  assert.equal(usage.totalCalls, 4);
  assert.equal(usage.distinctPrincipals, 2);
  assert.equal(usage.errorCount, 1);
  const stdio = usage.byTransport.find((t) => t.transport === 'stdio');
  assert.equal(stdio.calls, 2);
  assert.equal(stdio.principals, 1);
  assert.equal(stdio.lastTs, '2026-07-19T13:00:00.000Z');
  const searchTool = usage.byTool.find((t) => t.tool === 'search');
  assert.equal(searchTool.calls, 2);
  assert.equal(searchTool.errors, 1);
  assert.equal(usage.firstTs, '2026-07-19T10:00:00.000Z');
  assert.equal(usage.lastTs, '2026-07-19T13:00:00.000Z');
});

test('query themes group on normalized text, keep the latest spelling, split zero-result', () => {
  const events = [
    event({ args: { query: 'Curtain Wall  Firestop' } }),
    event({ ts: '2026-07-19T11:00:00.000Z', args: { query: 'curtain wall firestop' } }),
    event({
      ts: '2026-07-19T12:00:00.000Z',
      args: { query: 'post-tensioned transfer slab' },
      outcome: 'no_results',
    }),
    // A write tool with a query-shaped arg is not a query theme.
    event({ ts: '2026-07-19T13:00:00.000Z', tool: 'propose_knowledge', args: { query: 'not a search' } }),
  ];
  const usage = analyzeUsage(events, { tenantId: 'demo-firm' });
  assert.equal(usage.topQueries.length, 2);
  const grouped = usage.topQueries[0];
  assert.equal(grouped.count, 2);
  assert.equal(grouped.query, 'curtain wall firestop'); // latest raw spelling
  assert.equal(usage.zeroResultQueries.length, 1);
  assert.equal(usage.zeroResultQueries[0].query, 'post-tensioned transfer slab');
});

test('citationCounts: assistant read results only — web and write tools excluded', () => {
  const events = [
    event({ resultIds: ['detail:a', 'spec:b'] }),
    event({ ts: '2026-07-19T11:00:00.000Z', transport: 'http', tool: 'fetch', resultIds: ['detail:a'] }),
    // Duplicate ids inside one event count once (event-level counting).
    event({ ts: '2026-07-19T12:00:00.000Z', resultIds: ['detail:a', 'detail:a'] }),
    // The app's own reads are curation, not citations.
    event({ ts: '2026-07-19T13:00:00.000Z', transport: 'web', tool: 'search', resultIds: ['detail:a'] }),
    // Writes never count, whatever ids they touched.
    event({ ts: '2026-07-19T14:00:00.000Z', tool: 'propose_knowledge', resultIds: ['detail:a'] }),
    // Other tenants never count.
    event({ tenantId: 'other-firm', resultIds: ['detail:a'] }),
  ];
  const counts = citationCounts(events, 'demo-firm');
  assert.equal(counts.get('detail:a'), 3);
  assert.equal(counts.get('spec:b'), 1);
  const usage = analyzeUsage(events, { tenantId: 'demo-firm' });
  assert.deepEqual(usage.topCited[0], { id: 'detail:a', count: 3 });
});

test('since-window filters events and the coverage timestamps say so', () => {
  const events = [
    event({ ts: '2026-06-01T00:00:00.000Z' }),
    event({ ts: '2026-07-19T10:00:00.000Z' }),
  ];
  const usage = analyzeUsage(events, { tenantId: 'demo-firm', since: '2026-07-01T00:00:00.000Z' });
  assert.equal(usage.totalCalls, 1);
  assert.equal(usage.firstTs, '2026-07-19T10:00:00.000Z');
});
