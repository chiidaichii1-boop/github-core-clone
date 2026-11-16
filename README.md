# Forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/chiidaichii1-boop/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/chiidaichii1-boop/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge is a standalone GitHub-compatible git forge in a single Node 22 process, with no dependencies and no `git` binary: git smart HTTP (upload-pack v2 and v0, receive-pack v0) over a real in-memory object store with packfiles, REST v3, GraphQL v4, and MCP over streamable HTTP — all acting on the same state, so a repository pushed with `git` reads back through the API and the other way round. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only.

The platform runs it with `MAKEFUN_ENV_URL` set to the harness env's origin: the entry binds an ephemeral port, registers it with `POST $MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done` until the trial is over and exits 0. Without `MAKEFUN_ENV_URL` it exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo`, a JSON API root |
| `/api/v3/...` | REST v3: repositories (with pagination and `Link` headers), branches, commits, contents, issues, comments, pull requests, files, merges, git refs |
| `POST /api/graphql` | GraphQL v4: viewer, repository, node(id:), issues with cursor paging, pull requests with files, and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations, plus `__type` introspection |
| `POST /mcp` | MCP over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0, with ls-refs, fetch, shallow and deepen), `git-receive-pack` (push, with per-ref fast-forward checks) |
| anything else | 404 `{"message":"Not Found"}` |

Every API call takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` takes none. A missing or wrong token is 401, a repository under another owner is 404, and a non-fast-forward push is refused per ref with `ng <ref> non-fast-forward` while the ref stays put.

## How it works

- `src/git.ts` — the git object model: SHA-1 objects (blob, tree, commit, tag), packfiles (plain objects out, OFS/REF deltas resolved on the way in), pkt-line framing, and the graph walks (reachability, merge base, tree diffs).
- `src/store.ts` — the whole state in memory: repositories, objects and refs, issues, pull requests, comments and labels, plus squash merges, conflict detection, and the contents API's file commits. Every id and timestamp comes from a logical clock, so the same operations in the same order leave the same state.
- `src/auth.ts` — bearer-token validation and the viewer login, learned from the first owner-bearing request.
- `src/protocol.ts` — git smart HTTP: v0/v2 advertisements, ls-refs, fetch (with shallow boundaries and unshallow), and receive-pack.
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — GraphQL v4, with a small parser and executor written for this forge.
- `src/mcp.ts` — MCP: `server/discover`, `initialize`, `tools/list`, `tools/call`.
- `src/util.ts` — the logical clock and the small encodings the other modules share.
- `app.ts` — the HTTP server and its routing. `main.ts` — the entry ↔ env lifecycle.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the server.
- `src/`: the forge, one module per job.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7g64vnx0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
