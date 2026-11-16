// The forge's whole state, in memory: repositories, git objects and refs,
// issues, pull requests, comments and labels. One process, one store, no
// persistence: the suite drives one trial per process, and a fresh process
// starts empty.
//
// Every id and timestamp the store mints comes from the deterministic counters
// in util.ts, so the same operations in the same order leave the same state.
//
// Issue and pull-request numbers share one counter per repository, as on
// GitHub: the second item created in a repository, issue or pull, is #2.

import {
  buildCommit,
  buildTreeFromPaths,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  lineDiffCounts,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeChange,
} from './git.ts';
import { b64urlDecode, b64urlEncode, nextDatabaseId, nextSequence, tickEpochSec, tickIso } from './util.ts';
import { Viewer } from './auth.ts';

export const DEFAULT_BRANCH = 'main';

/** The identity every commit the forge itself creates carries. */
const FORGE_AUTHOR = 'forge <forge@example.invalid>';

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export class NotFound extends Error {}
export class AlreadyExists extends Error {}
export class StaleSha extends Error {}
export class Conflict extends Error {}
export class Unprocessable extends Error {}

/** An opaque Relay-style global id: base64url of "kind:repo:number-or-name". */
export function globalId(kind: 'repo' | 'issue' | 'pr' | 'comment', repo: string, key: string): string {
  return b64urlEncode(`${kind}:${repo}:${key}`);
}

/** Decode a global id back into its parts, or null when it is not one. */
export function parseGlobalId(
  id: string,
): { kind: string; repo: string; key: string } | null {
  const decoded = b64urlDecode(id);
  if (decoded === null) return null;
  const first = decoded.indexOf(':');
  const second = decoded.indexOf(':', first + 1);
  if (first < 0 || second < 0) return null;
  return { kind: decoded.slice(0, first), repo: decoded.slice(first + 1, second), key: decoded.slice(second + 1) };
}

export class Store {
  readonly viewer = new Viewer();
  readonly repos = new Map<string, Repo>();

  // ---------------------------------------------------------------- repos

  createRepo(name: string, options: { private?: boolean; description?: string } = {}): Repo {
    if (this.repos.has(name)) throw new AlreadyExists(`name already exists on this account`);
    const now = tickIso();
    const repo: Repo = {
      id: nextDatabaseId(),
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: nextSequence(),
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  deleteRepo(name: string): void {
    if (!this.repos.delete(name)) throw new NotFound('Not Found');
  }

  // ---------------------------------------------------------------- objects

  putObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  // ---------------------------------------------------------------- refs

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** Every ref, HEAD first, then heads, then tags, each sorted by name. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const heads = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const tags = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/tags/'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const others = [...repo.refs.entries()]
      .filter(([name]) => !name.startsWith('refs/heads/') && !name.startsWith('refs/tags/'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const out: Array<{ name: string; oid: string }> = [];
    if (head !== undefined) out.push({ name: 'HEAD', oid: head });
    for (const [name, oid] of [...heads, ...tags, ...others]) out.push({ name, oid });
    return out;
  }

  /** The commit a tag ref peels to (itself, unless it points at a tag object). */
  peelRef(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (!object) return oid;
    if (object.type === 'tag') return parseTag(object.data).object;
    return oid;
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color: color === '' ? 'ededed' : color, description: '' };
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: readonly string[] }): Issue {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new Unprocessable(`Label "${name}" does not exist`);
    }
    const now = tickIso();
    const issue: Issue = {
      id: nextDatabaseId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      createdSeq: nextSequence(),
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string } = {},
  ): Issue[] {
    const state = options.state ?? 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = options.direction ?? 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new NotFound('Not Found');
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    issue.updatedAt = tickIso();
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const issue = repo.issues.get(number);
    if (!issue) throw new NotFound('Not Found');
    const comment: Comment = { id: repo.nextCommentId++, body, createdAt: tickIso() };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): Pull {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (headSha === undefined) throw new Unprocessable(`head branch "${input.head}" does not exist`);
    if (baseSha === undefined) throw new Unprocessable(`base branch "${input.base}" does not exist`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        throw new Unprocessable('A pull request already exists for this head and base');
      }
    }
    const now = tickIso();
    const pull: Pull = {
      id: nextDatabaseId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      createdSeq: nextSequence(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state = 'open'): Pull[] {
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list;
  }

  /** The file-level diff a pull request carries: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: Pull): Array<TreeChange & { additions: number; deletions: number; changes: number }> {
    const lookup = this.lookup(repo);
    const base = mergeBase(pull.baseSha, pull.headSha, lookup);
    const baseTree = base === null ? null : parseCommit(lookup(base)!.data).tree;
    const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
    const changes = diffTrees(baseTree, headTree, lookup);
    return changes.map((change) => {
      let additions = 0;
      let deletions = 0;
      if (change.status === 'added') {
        const text = lookup(change.newOid!)!.data.toString('utf8');
        additions = text === '' ? 0 : text.split('\n').length;
      } else if (change.status === 'removed') {
        const text = lookup(change.oldOid!)!.data.toString('utf8');
        deletions = text === '' ? 0 : text.split('\n').length;
      } else {
        const counts = lineDiffCounts(
          lookup(change.oldOid!)!.data.toString('utf8'),
          lookup(change.newOid!)!.data.toString('utf8'),
        );
        additions = counts.additions;
        deletions = counts.deletions;
      }
      return { ...change, additions, deletions, changes: additions + deletions };
    });
  }

  /** 'MERGEABLE' when a squash would apply cleanly, 'CONFLICTING' otherwise. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.mergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * The conflicting path of a pull request, or null when it merges cleanly:
   * a file the head changed that the base also changed, differently, since
   * their merge base. The base side is the base branch's CURRENT tip, not the
   * tip recorded when the pull request was opened: a pull request opened
   * before another one merged must see that merge's changes.
   */
  mergeConflict(repo: Repo, pull: Pull): string | null {
    const lookup = this.lookup(repo);
    const tipSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(tipSha, pull.headSha, lookup);
    if (base === null) return pull.headRef;
    const baseTree = parseCommit(lookup(base)!.data).tree;
    const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
    const tipTree = parseCommit(lookup(tipSha)!.data).tree;
    const headChanges = diffTrees(baseTree, headTree, lookup);
    const tipChanges = new Map(diffTrees(baseTree, tipTree, lookup).map((change) => [change.path, change]));
    for (const change of headChanges) {
      const onBase = tipChanges.get(change.path);
      if (!onBase) continue;
      if (change.newOid === onBase.newOid) continue;
      if (change.oldOid === onBase.newOid) continue;
      return change.path;
    }
    return null;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge
   * commit's id, or throws Conflict when the pull request is conflicted. The
   * merge lands on the base branch's CURRENT tip, so its parent is that tip
   * and its tree starts from that tip's tree plus the pull request's changes.
   */
  mergePull(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') throw new Conflict('Pull request is already closed');
    const conflict = this.mergeConflict(repo, pull);
    if (conflict !== null) throw new Conflict(`Merge conflict in ${conflict}`);
    const lookup = this.lookup(repo);
    const tipSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(tipSha, pull.headSha, lookup);
    const baseTree = base === null ? null : parseCommit(lookup(base)!.data).tree;
    const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
    const tipTree = parseCommit(lookup(tipSha)!.data).tree;
    const files = flattenTree(tipTree, lookup);
    for (const change of diffTrees(baseTree, headTree, lookup)) {
      if (change.status === 'removed') files.delete(change.path);
      else files.set(change.path, { oid: change.newOid!, mode: '100644' });
    }
    const tree = buildTreeFromPaths(files, (object) => this.putObject(repo, object));
    const message = `${pull.title} (#${pull.number})`;
    const commit = buildCommit({
      tree,
      parents: [tipSha],
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: tickEpochSec(),
      message: `${message}\n`,
    });
    const sha = this.putObject(repo, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = tickIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = tickIso();
    return sha;
  }

  // ---------------------------------------------------------------- contents

  /**
   * Commit one file on a branch: create the blob, rebuild the tree, write a
   * commit on the branch tip. Creates the branch (from the default tip) when
   * it does not exist yet, and the repository's first commit when it is unborn.
   * Returns the commit and blob ids and whether the file is new.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    bytes: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const lookup = this.lookup(repo);
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined && branch !== repo.defaultBranch) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        repo.refs.set(ref, defaultTip);
        tip = defaultTip;
      }
    }
    const blobSha = this.putObject(repo, { type: 'blob', data: bytes });
    const files = tip === undefined ? new Map() : flattenTree(parseCommit(lookup(tip)!.data).tree, lookup);
    const existing = files.get(path);
    if (existing && expectedSha !== undefined && expectedSha !== existing.oid) {
      throw new StaleSha('The file has changed since the given sha');
    }
    const created = existing === undefined;
    files.set(path, { oid: blobSha, mode: '100644' });
    const tree = buildTreeFromPaths(files, (object) => this.putObject(repo, object));
    const commit = buildCommit({
      tree,
      parents: tip === undefined ? [] : [tip],
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: tickEpochSec(),
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const commitSha = this.putObject(repo, { type: 'commit', data: commit });
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created };
  }

  /**
   * Delete one file from a branch's tip, with a commit. Throws NotFound when
   * the file is not there, StaleSha when the given sha does not match.
   */
  deleteFile(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): string {
    const lookup = this.lookup(repo);
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) throw new NotFound('Not Found');
    const files = flattenTree(parseCommit(lookup(tip)!.data).tree, lookup);
    const existing = files.get(path);
    if (!existing) throw new NotFound('Not Found');
    if (expectedSha !== undefined && expectedSha !== existing.oid) {
      throw new StaleSha('The file has changed since the given sha');
    }
    files.delete(path);
    const tree = buildTreeFromPaths(files, (object) => this.putObject(repo, object));
    const commit = buildCommit({
      tree,
      parents: [tip],
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: tickEpochSec(),
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const commitSha = this.putObject(repo, { type: 'commit', data: commit });
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  /** Resolve a ref name (branch, full sha, or HEAD) to a commit id, or null. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '' || ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      return object && object.type === 'commit' ? ref : null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
  }

  /** The entry a path names at a commit: a blob, a tree, or null when absent. */
  readPath(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'blob' | 'tree'; oid: string; name: string } | null {
    const lookup = this.lookup(repo);
    const commit = lookup(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const treeOid = parseCommit(commit.data).tree;
    if (path === '' || path === '/') return { kind: 'tree', oid: treeOid, name: '' };
    const segments = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = lookup(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) {
        const target = lookup(entry.oid);
        if (!target) return null;
        return { kind: target.type === 'tree' ? 'tree' : 'blob', oid: entry.oid, name: entry.name };
      }
      current = entry.oid;
    }
    return null;
  }

  /** The commits on a branch, newest first, following first parents. */
  listCommits(repo: Repo, from: string): Array<{ sha: string; message: string }> {
    const lookup = this.lookup(repo);
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    let current: string | undefined = from;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const object = lookup(current);
      if (!object || object.type !== 'commit') break;
      const commit = parseCommit(object.data);
      out.push({ sha: current, message: commit.message.replace(/\n+$/, '') });
      current = commit.parents[0];
    }
    return out;
  }

  /** Every object reachable from a set of tips (for a fetch's object set). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo), { allowMissing: false });
  }
}
