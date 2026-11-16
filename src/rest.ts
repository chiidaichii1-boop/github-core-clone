// REST v3: the /api/v3 surface.
//
//   GET  /api/v3/                      (the API root; public)
//   GET  /api/v3/meta                  (installed_version; public)
//   GET  /api/v3/user                  (the viewer, once learned)
//   GET  /api/v3/user/repos           (paginated, Link rel="next")
//   POST /api/v3/user/repos           (create; a duplicate name is 422)
//   GET  /api/v3/repos/{o}/{r}        (read, patch, delete)
//   GET  /api/v3/repos/{o}/{r}/branches | /commits | /contents[/...]
//   PUT  /api/v3/repos/{o}/{r}/contents/{path}
//   DELETE /api/v3/repos/{o}/{r}/contents/{path}
//   GET|POST /api/v3/repos/{o}/{r}/issues[/{n}[/comments]]
//   PATCH /api/v3/repos/{o}/{r}/issues/{n}
//   GET|POST /api/v3/repos/{o}/{r}/pulls[/{n}[/files|merge]]
//   POST /api/v3/repos/{o}/{r}/git/refs
//
// Every reply is JSON and carries X-GitHub-Request-Id. Errors are JSON
// {"message": ...} with the HTTP status that fits: 401 without a token, 404
// for an unknown repository or a foreign owner, 422 for a duplicate name or
// an unknown label, 409 for a stale contents sha, 405 for a conflicted merge.
// The root and meta are public; everything else needs the token.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthenticated } from './auth.ts';
import { nextRequestId, tickIso } from './util.ts';
import {
  AlreadyExists,
  Conflict,
  NotFound,
  StaleSha,
  Unprocessable,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { parseTree } from './git.ts';

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: Json | unknown[] | null, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function fail(res: ServerResponse, status: number, message: string): void {
  send(res, status, { message });
}

/** The absolute URL of a request path, built from its Host header. */
function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${path}`;
}

/** The segments of a decoded REST path after /api/v3. */
function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
}

/** Read a page of items, with a Link header when more pages follow. */
function paginate<T>(res: ServerResponse, req: IncomingMessage, path: string, items: T[], query: URLSearchParams): T[] {
  const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const pageItems = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  if (page < totalPages) {
    const next = new URL(absoluteUrl(req, path));
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    links.push(`<${next.toString()}>; rel="next"`);
  }
  if (page > 1) {
    const prev = new URL(absoluteUrl(req, path));
    prev.searchParams.set('page', String(page - 1));
    prev.searchParams.set('per_page', String(perPage));
    links.push(`<${prev.toString()}>; rel="prev"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return pageItems;
}

/** The public shape of a repository, as the root, repo and branch endpoints show. */
function repoShape(store: Store, repo: Repo): Json {
  const owner = store.viewer.current ?? 'unknown';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `https://example.invalid/${owner}/${repo.name}.git`,
    html_url: `https://example.invalid/${owner}/${repo.name}`,
    url: `https://example.invalid/repos/${owner}/${repo.name}`,
  };
}

/** The public shape of an issue. */
function issueShape(store: Store, repo: Repo, issue: Issue): Json {
  const owner = store.viewer.current ?? 'unknown';
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: owner },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

/** The public shape of a pull request. */
function pullShape(store: Store, repo: Repo, pull: Pull): Json {
  const owner = store.viewer.current ?? 'unknown';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: owner },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** The commit shape a contents call answers with. */
function commitShape(sha: string): Json {
  return { sha, message: '', url: `https://example.invalid/commits/${sha}` };
}

/**
 * Find a repository the caller may see: the owner must be the viewer, and the
 * repository must exist. Throws NotFound for either failure.
 */
function findRepo(store: Store, owner: string, name: string): Repo {
  if (!store.viewer.isOwner(owner)) throw new NotFound('Not Found');
  const repo = store.getRepo(name);
  if (!repo) throw new NotFound('Not Found');
  return repo;
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const query = url.searchParams;
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const segments = segmentsOf(path.slice('/api/v3'.length));

  // The root and meta are public and need no token.
  if (req.method === 'GET' && segments.length === 0) {
    send(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo' });
    return true;
  }
  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    send(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (!isAuthenticated(req)) {
    fail(res, 401, 'Requires authentication');
    return true;
  }

  let payload: Json = {};
  if (body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      payload = parsed as Json;
    } catch {
      fail(res, 400, 'Malformed JSON in request body');
      return true;
    }
  }

  try {
    // GET /api/v3/user — the viewer, as learned so far.
    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'user') {
      const login = store.viewer.current;
      if (login === null) {
        fail(res, 404, 'Not Found');
        return true;
      }
      send(res, 200, { login, id: 1000 });
      return true;
    }

    // GET /api/v3/user/repos — paginated, oldest first.
    if (req.method === 'GET' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      const page = paginate(res, req, path, store.listRepos(), query);
      send(res, 200, page.map((repo) => repoShape(store, repo)));
      return true;
    }

    // POST /api/v3/user/repos — create a repository.
    if (req.method === 'POST' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (name === '') {
        fail(res, 422, 'name is required');
        return true;
      }
      const repo = store.createRepo(name, {
        private: payload.private === true,
        description: typeof payload.description === 'string' ? payload.description : undefined,
      });
      send(res, 201, repoShape(store, repo));
      return true;
    }

    // Everything below names /api/v3/repos/{owner}/{repo}[...].
    if (segments.length >= 3 && segments[0] === 'repos') {
      const owner = segments[1]!;
      const repoName = segments[2]!;
      const rest = segments.slice(3);
      const repo = findRepo(store, owner, repoName);

      // GET / PATCH / DELETE a repository.
      if (rest.length === 0) {
        if (req.method === 'GET') {
          send(res, 200, repoShape(store, repo));
          return true;
        }
        if (req.method === 'PATCH') {
          if (typeof payload.description === 'string') repo.description = payload.description;
          if (typeof payload.default_branch === 'string') repo.defaultBranch = payload.default_branch;
          repo.updatedAt = tickIso();
          send(res, 200, repoShape(store, repo));
          return true;
        }
        if (req.method === 'DELETE') {
          store.deleteRepo(repoName);
          send(res, 204, null);
          return true;
        }
        fail(res, 404, 'Not Found');
        return true;
      }

      // GET /branches — [{name, commit:{sha}}].
      if (rest.length === 1 && rest[0] === 'branches' && req.method === 'GET') {
        const branches = store
          .listRefs(repo)
          .filter(({ name }) => name.startsWith('refs/heads/'))
          .map(({ name, oid }) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid } }));
        send(res, 200, branches);
        return true;
      }

      // GET /commits[?sha=<branch>] — newest first, first-parent only.
      if (rest.length === 1 && rest[0] === 'commits' && req.method === 'GET') {
        const tip = store.resolveRef(repo, query.get('sha') ?? undefined);
        if (tip === null) {
          fail(res, 404, 'Not Found');
          return true;
        }
        const commits = store
          .listCommits(repo, tip)
          .map(({ sha, message }) => ({ sha, commit: { message }, url: `https://example.invalid/commits/${sha}` }));
        const page = paginate(res, req, path, commits, query);
        send(res, 200, page);
        return true;
      }

      // /contents[/...]
      if (rest[0] === 'contents') {
        const contentPath = rest.slice(1).join('/');
        const ref = query.get('ref') ?? undefined;
        if (req.method === 'GET') {
          const tip = store.resolveRef(repo, ref);
          if (tip === null) {
            fail(res, 404, 'Not Found');
            return true;
          }
          const entry = store.readPath(repo, tip, contentPath);
          if (!entry) {
            fail(res, 404, 'Not Found');
            return true;
          }
          if (entry.kind === 'tree') {
            const object = store.getObject(repo, entry.oid)!;
            const entries = parseTree(object.data);
            send(
              res,
              200,
              entries.map((treeEntry) => ({
                type: treeEntry.mode === '40000' ? 'dir' : 'file',
                name: treeEntry.name,
                path: contentPath === '' ? treeEntry.name : `${contentPath}/${treeEntry.name}`,
                sha: treeEntry.oid,
                size: 0,
              })),
            );
            return true;
          }
          const blob = store.getObject(repo, entry.oid)!;
          send(res, 200, {
            type: 'file',
            name: entry.name,
            path: contentPath,
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: entry.oid,
            size: blob.data.length,
          });
          return true;
        }
        if (req.method === 'PUT') {
          const message = typeof payload.message === 'string' ? payload.message : 'Update file';
          const content = typeof payload.content === 'string' ? payload.content : '';
          let bytes: Buffer;
          try {
            bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
          } catch {
            fail(res, 422, 'content is not valid base64');
            return true;
          }
          const branch = typeof payload.branch === 'string' ? payload.branch : repo.defaultBranch;
          const expected = typeof payload.sha === 'string' ? payload.sha : undefined;
          const result = store.commitFile(repo, branch, contentPath, bytes, message, expected);
          send(res, result.created ? 201 : 200, { content: { name: contentPath.split('/').pop() ?? '', path: contentPath, type: 'file', encoding: 'base64', sha: result.blobSha, size: bytes.length }, commit: commitShape(result.commitSha) });
          return true;
        }
        if (req.method === 'DELETE') {
          const message = typeof payload.message === 'string' ? payload.message : 'Delete file';
          const branch = typeof payload.branch === 'string' ? payload.branch : repo.defaultBranch;
          const expected = typeof payload.sha === 'string' ? payload.sha : undefined;
          const commitSha = store.deleteFile(repo, branch, contentPath, message, expected);
          send(res, 200, { commit: commitShape(commitSha) });
          return true;
        }
        fail(res, 404, 'Not Found');
        return true;
      }

      // /labels — list and create issue labels.
      if (rest[0] === 'labels') {
        if (rest.length === 1 && req.method === 'GET') {
          send(
            res,
            200,
            [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })),
          );
          return true;
        }
        if (rest.length === 1 && req.method === 'POST') {
          const name = typeof payload.name === 'string' ? payload.name : '';
          if (name === '') {
            fail(res, 422, 'name is required');
            return true;
          }
          if (repo.labels.has(name)) {
            fail(res, 422, 'Label already exists');
            return true;
          }
          const label = store.createLabel(repo, name, typeof payload.color === 'string' ? payload.color : 'ededed');
          if (typeof payload.description === 'string') label.description = payload.description;
          send(res, 201, { name: label.name, color: label.color, description: label.description });
          return true;
        }
        fail(res, 404, 'Not Found');
        return true;
      }

      // /issues[/{n}[/comments]]
      if (rest[0] === 'issues') {
        if (rest.length === 1 && req.method === 'GET') {
          const issues = store.listIssues(repo, {
            state: query.get('state') ?? undefined,
            sort: query.get('sort') ?? undefined,
            direction: query.get('direction') ?? undefined,
          });
          const page = paginate(res, req, path, issues, query);
          send(res, 200, page.map((issue) => issueShape(store, repo, issue)));
          return true;
        }
        if (rest.length === 1 && req.method === 'POST') {
          const title = typeof payload.title === 'string' ? payload.title : '';
          if (title === '') {
            fail(res, 422, 'title is required');
            return true;
          }
          const labels = Array.isArray(payload.labels)
            ? (payload.labels as unknown[]).filter((label) => typeof label === 'string').map(String)
            : [];
          const issue = store.createIssue(repo, {
            title,
            body: typeof payload.body === 'string' ? payload.body : undefined,
            labels,
          });
          send(res, 201, issueShape(store, repo, issue));
          return true;
        }
        const number = Number.parseInt(rest[1] ?? '', 10);
        if (rest.length >= 2 && Number.isInteger(number)) {
          if (rest.length === 2 && req.method === 'GET') {
            const issue = store.getIssue(repo, number);
            if (!issue) {
              fail(res, 404, 'Not Found');
              return true;
            }
            send(res, 200, issueShape(store, repo, issue));
            return true;
          }
          if (rest.length === 2 && req.method === 'PATCH') {
            const issue = store.patchIssue(repo, number, {
              state: typeof payload.state === 'string' ? payload.state : undefined,
              title: typeof payload.title === 'string' ? payload.title : undefined,
              body: typeof payload.body === 'string' ? payload.body : undefined,
            });
            send(res, 200, issueShape(store, repo, issue));
            return true;
          }
          if (rest.length === 3 && rest[2] === 'comments' && req.method === 'GET') {
            const issue = store.getIssue(repo, number);
            if (!issue) {
              fail(res, 404, 'Not Found');
              return true;
            }
            send(
              res,
              200,
              issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt })),
            );
            return true;
          }
          if (rest.length === 3 && rest[2] === 'comments' && req.method === 'POST') {
            const comment = store.addComment(repo, number, typeof payload.body === 'string' ? payload.body : '');
            send(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt });
            return true;
          }
        }
        fail(res, 404, 'Not Found');
        return true;
      }

      // /pulls[/{n}[/files|merge]]
      if (rest[0] === 'pulls') {
        if (rest.length === 1 && req.method === 'GET') {
          const pulls = store.listPulls(repo, query.get('state') ?? 'open');
          const page = paginate(res, req, path, pulls, query);
          send(res, 200, page.map((pull) => pullShape(store, repo, pull)));
          return true;
        }
        if (rest.length === 1 && req.method === 'POST') {
          const title = typeof payload.title === 'string' ? payload.title : '';
          const head = typeof payload.head === 'string' ? payload.head : '';
          const base = typeof payload.base === 'string' ? payload.base : '';
          if (title === '' || head === '' || base === '') {
            fail(res, 422, 'title, head and base are required');
            return true;
          }
          const pull = store.createPull(repo, {
            title,
            body: typeof payload.body === 'string' ? payload.body : undefined,
            head,
            base,
          });
          send(res, 201, pullShape(store, repo, pull));
          return true;
        }
        const number = Number.parseInt(rest[1] ?? '', 10);
        if (rest.length >= 2 && Number.isInteger(number)) {
          if (rest.length === 2 && req.method === 'GET') {
            const pull = store.getPull(repo, number);
            if (!pull) {
              fail(res, 404, 'Not Found');
              return true;
            }
            send(res, 200, pullShape(store, repo, pull));
            return true;
          }
          if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') {
            const pull = store.getPull(repo, number);
            if (!pull) {
              fail(res, 404, 'Not Found');
              return true;
            }
            send(
              res,
              200,
              store.pullFiles(repo, pull).map((change) => ({
                filename: change.path,
                status: change.status,
                additions: change.additions,
                deletions: change.deletions,
                changes: change.changes,
                sha: change.newOid ?? change.oldOid ?? '',
              })),
            );
            return true;
          }
          if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') {
            const pull = store.getPull(repo, number);
            if (!pull) {
              fail(res, 404, 'Not Found');
              return true;
            }
            if (pull.state !== 'open') {
              fail(res, 405, 'Pull request is already closed');
              return true;
            }
            const sha = store.mergePull(repo, pull);
            send(res, 200, { sha, merged: true, message: `Pull Request #${pull.number} merged` });
            return true;
          }
          if (rest.length === 3 && rest[2] === 'merge' && req.method === 'GET') {
            const pull = store.getPull(repo, number);
            if (!pull) {
              fail(res, 404, 'Not Found');
              return true;
            }
            send(res, 200, { merged: pull.merged });
            return true;
          }
        }
        fail(res, 404, 'Not Found');
        return true;
      }

      // /git/refs — create a ref.
      if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && req.method === 'POST') {
        const ref = typeof payload.ref === 'string' ? payload.ref : '';
        const sha = typeof payload.sha === 'string' ? payload.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          fail(res, 422, 'ref and sha are required');
          return true;
        }
        if (store.getRef(repo, ref) !== undefined) {
          fail(res, 422, 'Reference already exists');
          return true;
        }
        if (!store.getObject(repo, sha)) {
          fail(res, 422, 'Object does not exist');
          return true;
        }
        store.setRef(repo, ref, sha);
        send(res, 201, { ref, object: { sha } });
        return true;
      }

      fail(res, 404, 'Not Found');
      return true;
    }
  } catch (err) {
    if (err instanceof NotFound) {
      fail(res, 404, 'Not Found');
      return true;
    }
    if (err instanceof AlreadyExists) {
      fail(res, 422, err.message);
      return true;
    }
    if (err instanceof Unprocessable) {
      fail(res, 422, err.message);
      return true;
    }
    if (err instanceof StaleSha) {
      fail(res, 409, err.message);
      return true;
    }
    if (err instanceof Conflict) {
      fail(res, 405, err.message);
      return true;
    }
    throw err;
  }

  fail(res, 404, 'Not Found');
  return true;
}
