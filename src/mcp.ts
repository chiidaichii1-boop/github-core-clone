// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp, plus DELETE /mcp.
//
// The client first asks for `server/discover` (the 2026-07-28 revision) and
// falls back to `initialize` when that method is unknown. Both are answered
// here, together with `tools/list` and `tools/call` for six tools that act on
// the same store as REST and GraphQL, so a change made through one surface
// reads back through the others.
//
//   create_repo          {name}
//   get_repo             {owner, repo}
//   create_issue         {owner, repo, title, body?}
//   list_issues          {owner, repo, state?}
//   create_pull_request  {owner, repo, title, head, base}
//   merge_pull_request   {owner, repo, pull_number}
//
// A tool result is {content: [{type: 'text', text: <pretty JSON>}], 
// structuredContent: <the object>}; a failed call is the same shape with
// isError: true. An unknown tool is a JSON-RPC -32601 error, a body that is
// not JSON is HTTP 400 with -32700, and a request without a token is 401.
// A notification (no id) is answered with HTTP 202 and an empty body, and
// DELETE /mcp is 204.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthenticated } from './auth.ts';
import { nextRequestId } from './util.ts';
import {
  AlreadyExists,
  Conflict,
  NotFound,
  Unprocessable,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28'];

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The repository name.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch onto another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The public shape of a repository, as REST shows it. */
function repoShape(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewer.current ?? 'unknown';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

/** The public shape of an issue, as REST shows it. */
function issueShape(store: Store, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** Find a repository a tool call may see, learning the viewer as REST does. */
function findRepo(store: Store, owner: string, name: string): Repo {
  if (!store.viewer.isOwner(owner)) throw new NotFound('Not Found');
  const repo = store.getRepo(name);
  if (!repo) throw new NotFound('Not Found');
  return repo;
}

/** A successful tool result: pretty JSON text plus the structured object. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/** A failed tool result: the message as text, marked as an error. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one tool by name with its arguments. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const number = (value: unknown): number => (typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10));

  if (name === 'create_repo') {
    const repoName = text(args.name);
    if (repoName === '') throw new Error('name is required');
    return toolResult(repoShape(store, store.createRepo(repoName)));
  }
  if (name === 'get_repo') {
    const repo = findRepo(store, text(args.owner), text(args.repo));
    return toolResult(repoShape(store, repo));
  }
  if (name === 'create_issue') {
    const repo = findRepo(store, text(args.owner), text(args.repo));
    const title = text(args.title);
    if (title === '') throw new Error('title is required');
    const issue = store.createIssue(repo, { title, body: text(args.body) === '' ? undefined : text(args.body) });
    return toolResult(issueShape(store, repo, issue));
  }
  if (name === 'list_issues') {
    const repo = findRepo(store, text(args.owner), text(args.repo));
    const state = text(args.state) === '' ? 'open' : text(args.state);
    const issues = store.listIssues(repo, { state });
    return toolResult(issues.map((issue) => issueShape(store, repo, issue)));
  }
  if (name === 'create_pull_request') {
    const repo = findRepo(store, text(args.owner), text(args.repo));
    const pull = store.createPull(repo, {
      title: text(args.title),
      head: text(args.head),
      base: text(args.base),
    });
    return toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    });
  }
  if (name === 'merge_pull_request') {
    const repo = findRepo(store, text(args.owner), text(args.repo));
    const pull = store.getPull(repo, number(args.pull_number));
    if (!pull) throw new NotFound('Not Found');
    const sha = store.mergePull(repo, pull);
    return toolResult({ number: pull.number, merged: true, sha, state: pull.state });
  }
  throw new Error(`Unknown tool: ${name}`);
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Answer one JSON-RPC request object. */
function handleRequest(store: Store, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id ?? null;
  const method = request.method ?? '';
  const params = request.params ?? {};

  // A notification (no id) is acknowledged with nothing to send back.
  if (request.id === undefined) {
    return null;
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      serverInfo: SERVER_INFO,
      capabilities: { tools: { listChanged: false } },
      supportedVersions: SUPPORTED_VERSIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0]!;
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    // The client may name a tool with a prefix (github__create_issue); the
    // match is on the suffix, case-insensitive.
    const tool = TOOLS.find(
      (candidate) => candidate.name === toolName || toolName.toLowerCase().endsWith(candidate.name),
    );
    if (!tool) return rpcError(id, -32601, `Unknown tool: ${toolName}`);
    try {
      return rpcResult(id, callTool(store, tool.name, toolArgs));
    } catch (err) {
      if (err instanceof AlreadyExists || err instanceof Unprocessable || err instanceof Conflict) {
        return rpcResult(id, toolError((err as Error).message));
      }
      if (err instanceof NotFound) {
        return rpcResult(id, toolError('Not Found'));
      }
      return rpcResult(id, toolError((err as Error).message));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/mcp') return false;
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' });
    return true;
  }
  if (!isAuthenticated(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed
      .map((item) => handleRequest(store, item as JsonRpcRequest))
      .filter((result) => result !== null);
    sendJson(res, 200, results);
    return true;
  }
  const result = handleRequest(store, parsed as JsonRpcRequest);
  if (result === null) {
    // A lone notification: 202 with an empty body.
    res.writeHead(202, { 'x-github-request-id': nextRequestId(), 'content-length': 0 });
    res.end();
    return true;
  }
  sendJson(res, 200, result);
  return true;
}
