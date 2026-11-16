// GraphQL v4: one POST /api/graphql, JSON-RPC style, with a small parser and
// executor written for this forge. It answers the documents the conformance
// suite sends: viewer, repository (fields, issue, issues with cursor paging,
// pullRequests, pullRequest with files), node(id:) with inline fragments,
// mutations (createIssue, closeIssue, createPullRequest, mergePullRequest,
// addComment), and __type introspection. A batch (an array of operations) is
// answered as an array, in order. An unknown repository answers
// data.repository = null with no errors; an unknown field is a 200 with an
// errors entry naming the field. Without a token the answer is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthenticated } from './auth.ts';
import { b64urlDecode, b64urlEncode, nextRequestId } from './util.ts';
import { globalId, parseGlobalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------ parsing

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  arguments: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        const c = source[index]!;
        if (c === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1]!;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u' && index + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
          } else if (simple[escaped] !== undefined) {
            value += simple[escaped];
            index += 2;
          } else {
            value += escaped;
            index += 2;
          }
        } else {
          value += c;
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let end = index;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      let isFloat = false;
      if (source[end] === '.') {
        isFloat = true;
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${index}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    const token = this.tokens[this.index]!;
    if (this.index < this.tokens.length - 1) this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" but got ${JSON.stringify(token)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name but got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`Expected "${value}" but got "${token.value}"`);
    return token.value;
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const definitions: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        definitions.push({ kind: 'operation', operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipVariableDefinitions();
        definitions.push({ kind: 'operation', operation, name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        definitions.push({ kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token ${JSON.stringify(token)} in document`);
      }
    }
    return definitions;
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('Unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (nextToken.kind === 'name') {
        return { kind: 'spread', name: this.next().value as string };
      }
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind !== 'name') throw new Error(`Expected a field name but got ${JSON.stringify(token)}`);
    const first = this.next().value as string;
    let name = first;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@skip, @include, ...) are read and ignored.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) this.parseValue();
        this.expectPunct(')');
      }
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, arguments: args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected token ${JSON.stringify(token)} as a value`);
  }
}

// ------------------------------------------------------------------ schema

/** The fields each type answers, used to reject unknown fields. */
const SCHEMA: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  PullRequest: new Set(['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files']),
  User: new Set(['login']),
  BranchRef: new Set(['name']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PullRequestConnection: new Set(['nodes', 'pageInfo']),
  PullRequestFileConnection: new Set(['nodes']),
  PullRequestFile: new Set(['path', 'additions', 'deletions']),
  IssueComment: new Set(['id', 'body']),
  IssueCommentEdge: new Set(['node']),
  PageInfo: new Set(['hasNextPage', 'endCursor']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  __Type: new Set(['name', 'fields', 'enumValues', 'kind']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
  __Schema: new Set(['queryType', 'mutationType', 'types']),
};

/** The child type of a field that carries a selection set. */
const CHILD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: '', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { owner: 'User', defaultBranchRef: 'BranchRef', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestFileConnection' },
  PullRequestFileConnection: { nodes: 'PullRequestFile' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
};

/** The introspection record for a named type, or null when it is not one. */
function typeInfo(name: string): Record<string, unknown> | null {
  const fields: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body'],
    PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    SearchType: [],
    Query: ['viewer', 'repository', 'node'],
    Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    User: ['login'],
  };
  const enums: Record<string, string[]> = {
    SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  };
  if (fields[name] === undefined && enums[name] === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: enums[name] !== undefined ? 'ENUM' : 'OBJECT',
    fields: (fields[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName })),
    enumValues: (enums[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
  };
}

// ------------------------------------------------------------------ execution

interface Context {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evaluateValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = evaluateValue(arg.value, ctx.variables);
  return out;
}

type AnyObject = Record<string, unknown> & { __typename?: string };

/** A repository value, with the store repository attached for its resolvers. */
function repoValue(store: Store, repo: Repo): AnyObject {
  return { __typename: 'Repository', repo, owner: store.viewer.current ?? '' };
}

function issueValue(repo: Repo, issue: Issue): AnyObject {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): AnyObject {
  return { __typename: 'PullRequest', repo, pull };
}

/** A cursor for a page of issues: the created sequence of the last node. */
function cursorFor(seq: number): string {
  return b64urlEncode(`cursor:${seq}`);
}

function seqFromCursor(cursor: string): number | null {
  const decoded = b64urlDecode(cursor);
  if (decoded === null || !decoded.startsWith('cursor:')) return null;
  const seq = Number.parseInt(decoded.slice('cursor:'.length), 10);
  return Number.isFinite(seq) ? seq : null;
}

/** A connection over issues, in newest-first order, with cursor paging. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): AnyObject {
  const first = typeof args.first === 'number' ? args.first : 10;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction ?? 'DESC';
  let list = [...repo.issues.values()];
  if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
  list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const after = typeof args.after === 'string' ? seqFromCursor(args.after) : null;
  if (after !== null) list = list.filter((issue) => (direction === 'ASC' ? issue.createdSeq > after : issue.createdSeq < after));
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.createdSeq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueValue(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

/** A connection over pull requests, in newest-first order. */
function pullsConnection(repo: Repo, args: Record<string, unknown>): AnyObject {
  const first = typeof args.first === 'number' ? args.first : 10;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = [...repo.pulls.values()];
  if (states !== null) list = list.filter((pull) => states.includes(pull.state.toUpperCase()));
  list.sort((a, b) => b.createdSeq - a.createdSeq);
  const after = typeof args.after === 'string' ? seqFromCursor(args.after) : null;
  if (after !== null) list = list.filter((pull) => pull.createdSeq < after);
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.createdSeq) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullValue(repo, pull)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

/** Resolve one field on a parent value of the given type. */
function resolveField(parentType: string, parent: AnyObject, field: FieldNode, ctx: Context): unknown {
  const args = argsOf(field, ctx);
  const store = ctx.store;

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: store.viewer.current };
    }
    if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (owner !== '') store.viewer.learn(owner);
      const repo = store.getRepo(name);
      if (!repo || !store.viewer.isOwner(owner)) return null;
      return repoValue(store, repo);
    }
    if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const parts = parseGlobalId(id);
      if (!parts) return null;
      const repo = store.getRepo(parts.repo);
      if (!repo) return null;
      if (parts.kind === 'repo') return repoValue(store, repo);
      if (parts.kind === 'issue') {
        const issue = repo.issues.get(Number.parseInt(parts.key, 10));
        return issue ? issueValue(repo, issue) : null;
      }
      if (parts.kind === 'pr') {
        const pull = repo.pulls.get(Number.parseInt(parts.key, 10));
        return pull ? pullValue(repo, pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      return typeInfo(name);
    }
    if (field.name === '__schema') {
      return {
        __typename: '__Schema',
        queryType: { __typename: '__Type', name: 'Query' },
        mutationType: { __typename: '__Type', name: 'Mutation' },
        types: ['Query', 'Mutation', 'Repository', 'Issue', 'PullRequest', 'User', 'SearchType'].map((name) => typeInfo(name)!),
      };
    }
  }

  if (parentType === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const parts = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parts ? store.getRepo(parts.repo) : undefined;
      if (!repo) throw new Error('Repository not found');
      const issue = store.createIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const parts = parseGlobalId(String(input.issueId ?? ''));
      const repo = parts ? store.getRepo(parts.repo) : undefined;
      const issue = repo && parts ? repo.issues.get(Number.parseInt(parts.key, 10)) : undefined;
      if (!repo || !issue) throw new Error('Issue not found');
      store.patchIssue(repo, issue.number, { state: 'closed' });
      return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue) };
    }
    if (field.name === 'createPullRequest') {
      const parts = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parts ? store.getRepo(parts.repo) : undefined;
      if (!repo) throw new Error('Repository not found');
      const pull = store.createPull(repo, {
        title: String(input.title ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
    }
    if (field.name === 'mergePullRequest') {
      const parts = parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parts ? store.getRepo(parts.repo) : undefined;
      const pull = repo && parts ? repo.pulls.get(Number.parseInt(parts.key, 10)) : undefined;
      if (!repo || !pull) throw new Error('Pull request not found');
      store.mergePull(repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) };
    }
    if (field.name === 'addComment') {
      const parts = parseGlobalId(String(input.subjectId ?? ''));
      const repo = parts ? store.getRepo(parts.repo) : undefined;
      const issue = repo && parts ? repo.issues.get(Number.parseInt(parts.key, 10)) : undefined;
      if (!repo || !issue) throw new Error('Subject not found');
      const comment = store.addComment(repo, issue.number, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('comment', repo.name, String(comment.id)), body: comment.body },
        },
      };
    }
  }

  if (parentType === 'Repository') {
    const repo = parent.repo as Repo;
    const owner = (parent.owner as string) || store.viewer.current || '';
    switch (field.name) {
      case 'id':
        return globalId('repo', repo.name, repo.name);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: owner };
      case 'defaultBranchRef':
        return { __typename: 'BranchRef', name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.get(number);
        return issue ? issueValue(repo, issue) : null;
      }
      case 'issues':
        return issuesConnection(repo, args);
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.get(number);
        return pull ? pullValue(repo, pull) : null;
      }
      case 'pullRequests':
        return pullsConnection(repo, args);
    }
  }

  if (parentType === 'Issue') {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    switch (field.name) {
      case 'id':
        return globalId('issue', repo.name, String(issue.number));
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state.toUpperCase();
      case 'body':
        return issue.body;
    }
  }

  if (parentType === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (field.name) {
      case 'id':
        return globalId('pr', repo.name, String(pull.number));
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'state':
        return pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return store.pullMergeable(repo, pull);
      case 'files':
        return {
          __typename: 'PullRequestFileConnection',
          nodes: store.pullFiles(repo, pull).map((change) => ({
            __typename: 'PullRequestFile',
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
          })),
        };
    }
  }

  // Plain objects (introspection records, pageInfo, payloads) answer a field
  // from the property of the same name.
  if (typeof parent[field.name] !== 'undefined') return parent[field.name];
  return null;
}

function executeSelectionSet(selections: SelectionNode[], parentType: string, parent: AnyObject, ctx: Context): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      Object.assign(result, executeSelectionSet(fragment.selectionSet, parentType, parent, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(result, executeSelectionSet(selection.selectionSet, parentType, parent, ctx));
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      result[responseKey] = parentType;
      continue;
    }
    if (!SCHEMA[parentType]?.has(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(parentType, parent, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      continue;
    }
    if (field.selectionSet !== null && value !== null && value !== undefined) {
      const childType = (value as AnyObject).__typename ?? CHILD_TYPES[parentType]?.[field.name] ?? '';
      if (Array.isArray(value)) {
        result[responseKey] = value.map((item) => executeSelectionSet(field.selectionSet!, childType, item as AnyObject, ctx));
      } else {
        result[responseKey] = executeSelectionSet(field.selectionSet!, childType, value as AnyObject, ctx);
      }
    } else {
      result[responseKey] = value ?? null;
    }
  }
  return result;
}

function executeOne(operation: { query?: unknown; variables?: unknown; operationName?: unknown }, store: Store): Record<string, unknown> {
  const ctx: Context = {
    store,
    variables: (operation.variables ?? {}) as Record<string, unknown>,
    fragments: new Map(),
    errors: [],
  };
  const query = typeof operation.query === 'string' ? operation.query : '';
  let definitions: Array<OperationNode | FragmentNode>;
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  for (const definition of definitions) {
    if (definition.kind === 'fragment') ctx.fragments.set(definition.name, definition);
  }
  const operations = definitions.filter((definition): definition is OperationNode => definition.kind === 'operation');
  let chosen: OperationNode | undefined;
  if (typeof operation.operationName === 'string') {
    chosen = operations.find((op) => op.name === operation.operationName);
  }
  chosen = chosen ?? operations[0];
  if (!chosen) return { data: null, errors: [{ message: 'No operation in document' }] };
  const rootType = chosen.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(chosen.selectionSet, rootType, {}, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

// ------------------------------------------------------------------ handler

export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    const text = `${JSON.stringify({ message: 'Method not allowed' })}\n`;
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId(), 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return true;
  }
  if (!isAuthenticated(req)) {
    const text = `${JSON.stringify({ message: 'Requires authentication' })}\n`;
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId(), 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    const text = `${JSON.stringify({ errors: [{ message: 'Malformed JSON in request body' }] })}\n`;
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId(), 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return true;
  }
  const result = Array.isArray(parsed) ? parsed.map((item) => executeOne(item as Record<string, unknown>, store)) : executeOne(parsed as Record<string, unknown>, store);
  const text = `${JSON.stringify(result)}\n`;
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId(), 'content-length': Buffer.byteLength(text) });
  res.end(text);
  return true;
}
