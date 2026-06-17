#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { startHttp } from './http.js';

// EKG_TRANSPORT selects the transport. stdio (default) is the single-user
// local dev path with a fixed caller; http is the remote, multi-user gateway
// that resolves each caller from a bearer token (PRD P0-3).
const transport = (process.env.EKG_TRANSPORT ?? 'stdio').toLowerCase();

if (transport === 'http') {
  await startHttp();
} else {
  const server = await createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; log to stderr only.
  console.error('ekg-mcp: knowledge graph gateway listening on stdio');
}
