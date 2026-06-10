#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built MCP server on stdio, performs the
 * MCP handshake, lists tools, and runs a search against the seeded demo
 * graph. Exits non-zero on any failure.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function assert(cond, label) {
  if (!cond) throw new Error(`smoke failed: ${label}`);
  console.log(`ok - ${label}`);
}

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  assert(init.serverInfo?.name === 'ekg-mcp', 'initialize handshake');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tools = await request(2, 'tools/list', {});
  const names = tools.tools.map((t) => t.name).sort();
  assert(
    ['fetch', 'search', 'traverse'].every((n) => names.includes(n)),
    `tools registered (${names.join(', ')})`,
  );

  const search = await request(3, 'tools/call', {
    name: 'search',
    arguments: { query: 'curtain wall firestop' },
  });
  const payload = JSON.parse(search.content[0].text);
  assert(payload.results?.length > 0, 'search returns seeded results');
  assert(payload.results[0].provenance?.reviewStatus, 'results carry provenance (P0-8)');
  const superseded = payload.results.find((r) => r.id === 'detail:cw-firestop-01');
  assert(superseded?.warning, 'superseded result carries warning (P0-8)');

  const noHits = await request(4, 'tools/call', {
    name: 'search',
    arguments: { query: 'zzz-no-such-topic-zzz' },
  });
  const empty = JSON.parse(noHits.content[0].text);
  assert(empty.no_results === true && empty.guidance, 'explicit no_results state (P0-8)');

  const traverse = await request(5, 'tools/call', {
    name: 'traverse',
    arguments: { entityId: 'detail:cw-firestop-02', relationshipType: 'used-in' },
  });
  const graph = JSON.parse(traverse.content[0].text);
  assert(graph.neighbors?.[0]?.id === 'project:riverside', 'traverse follows relationships');

  console.log('smoke: all checks passed');
  child.kill();
  process.exit(0);
} catch (err) {
  console.error(String(err));
  child.kill();
  process.exit(1);
}
