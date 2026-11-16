// The HTTP application: one store, one server, five surfaces.
//
//   GET  /healthz                 (no auth; the env's boot probe, 200 {"ok":true})
//   POST /api/graphql             (GraphQL v4)
//   POST /mcp                     (MCP over streamable HTTP)
//   /api/v3/...                   (REST v3)
//   /{owner}/{repo}.git/...       (git smart HTTP)
//
// Everything else is a JSON 404, and anything a handler throws is a JSON 500
// with the request id the REST and GraphQL surfaces carry. Bodies are read
// whole before routing: the git surface needs the raw bytes of a pack.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { gitPathOf, handleGit } from './src/protocol.ts';
import { nextRequestId } from './src/util.ts';

/** The largest request body the forge reads (a push pack is the big one). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendError(res: ServerResponse, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read a request body whole, or reject when it grows past the limit. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const body = await readBody(req);
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;

  if (path === '/healthz' && req.method === 'GET') {
    const text = `${JSON.stringify({ ok: true })}\n`;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  if (await handleRest(req, res, store, body)) return;
  if (await handleGraphQL(req, res, store, body)) return;
  if (await handleMcp(req, res, store, body)) return;
  const git = gitPathOf(path);
  if (git !== null && handleGit(req, res, store, git.owner, git.repo, git.suffix, body)) return;

  sendError(res, 404, 'Not Found');
}

/** Build the server for one fresh, empty store. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req, res) => {
    dispatch(req, res, store).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      else res.end();
    });
  });
}
