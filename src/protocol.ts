// git smart HTTP: the /{owner}/{repo}.git surface.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack    (ls-refs and fetch, v2 or v0)
//   POST /{owner}/{repo}.git/git-receive-pack   (push, v0 only)
//
// upload-pack speaks protocol v2 when the client asks with
// `Git-Protocol: version=2`, and v0 otherwise; receive-pack is v0 only. A
// missing repository is 404 on both services and the server stays up. Every
// update must fast-forward: a non-fast-forward push is refused per ref with
// "ng <ref> non-fast-forward" and the ref does not move.
//
// Packs are plain objects (no deltas) on the way out; packs coming in may
// carry OFS/REF deltas (a real git client sends them) and are resolved on read.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectHeld,
  collectReachable,
  collectTreeObjects,
  decodePktLines,
  encodePktLines,
  isAncestor,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { isHex40 } from './util.ts';
import { isAuthenticated } from './auth.ts';
import { type Repo, type Store } from './store.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Send a binary git answer. */
function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Send a JSON error for a git path (a 404 a missing repository answers). */
function sendJsonError(res: ServerResponse, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** One advertised ref, with the peeled id when it points at an annotated tag. */
interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** The refs a v0 advertisement lists, in git's order (HEAD first). */
function v0Refs(repo: Repo, store: Store): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  for (const { name, oid } of store.listRefs(repo)) {
    if (name === 'HEAD') continue;
    const object = store.getObject(repo, oid);
    const entry: AdvertisedRef = { name, oid };
    if (object && object.type === 'tag') entry.peeled = store.peelRef(repo, oid);
    out.push(entry);
  }
  return out;
}

/** The v0 capability list for upload-pack, on the first ref line. */
function uploadCaps(branch: string): string {
  return `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${branch}`;
}

/** The v0 capability list for receive-pack, on the first ref line. */
function receiveCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** A v0 advertisement body: the service preamble, a flush, the ref lines, a flush. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, store: Store): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo.defaultBranch) : receiveCaps();
  const refs = v0Refs(repo, store);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
    // The capabilities ride on the first line: HEAD when it exists (an extra
    // line beside the ref list), else the first ref, which is then not
    // repeated below. Every ref is listed, including the default branch.
    let capsName: string | null = null;
    if (head !== undefined) {
      lines.push(`${head} HEAD\0${caps}\n`);
    } else {
      lines.push(`${refs[0]!.oid} ${refs[0]!.name}\0${caps}\n`);
      capsName = refs[0]!.name;
    }
    for (const ref of refs) {
      if (ref.name === capsName) continue;
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** A v2 capability advertisement: "version 2" and one capability per line. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------- ls-refs

/** Parse a v2 ls-refs request body into its arguments. */
function parseLsRefsArgs(body: Buffer): { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] } {
  const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return args;
  }
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** Answer a v2 ls-refs: one line per matching ref, then a flush. */
function lsRefs(repo: Repo, store: Store, body: Buffer): Buffer {
  const args = parseLsRefsArgs(body);
  const lines: Array<string | 'flush'> = [];
  const refs = store.listRefs(repo);
  const headOid = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (headOid === undefined) {
    if (args.unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    if (keep('HEAD') && args.symrefs) lines.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else if (keep('HEAD') && !args.symrefs) lines.push(`${headOid} HEAD\n`);
  }
  for (const { name, oid } of refs) {
    if (name === 'HEAD' || !keep(name)) continue;
    const object = store.getObject(repo, oid);
    let line = `${oid} ${name}`;
    if (args.peel && object && object.type === 'tag') line += ` peeled:${store.peelRef(repo, oid)}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** The deepen is relative to the client's current shallow depth (real git). */
  deepenRelative: boolean;
}

/** Parse a v2 fetch request body (or a v0 one: the same lines, two sections). */
function parseFetchArgs(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false };
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return args;
  }
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

interface FetchPlan {
  /** The objects to send, in a deterministic order. */
  objects: GitObject[];
  /** The acknowledgment lines (NAK, or ACKs + ready). */
  acks: string[];
  /** Shallow boundaries after this fetch. */
  shallow: string[];
  /** Boundaries that stopped being shallow. */
  unshallow: string[];
}

/**
 * Work out what a fetch sends: the depth-limited closure of the wants minus
 * everything reachable from the haves, and the shallow boundaries after it.
 */
function planFetch(repo: Repo, store: Store, args: FetchArgs): FetchPlan {
  const lookup = store.lookup(repo);
  const wants = [...new Set(args.wants)].filter((oid) => isHex40(oid));
  const haves = [...new Set(args.haves)].filter((oid) => isHex40(oid));
  const clientShallow = [...new Set(args.shallow)].filter((oid) => isHex40(oid));
  const depth = args.depth;

  // Expand tag wants to their targets, keeping the tag objects themselves.
  const tagObjects = new Set<string>();
  const tips: string[] = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjects.add(want);
      tips.push(parseTag(object.data).object);
    } else {
      tips.push(want);
    }
  }

  // The distance of each commit from a want, for a relative deepen: a client
  // that deepens by N from its current shallow depth asks for depth
  // (current depth) + N, where the current depth is one more than the
  // farthest shallow boundary's distance from the tip.
  let effectiveDepth = depth;
  if (depth !== null && args.deepenRelative) {
    const distances = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = tips.map((oid) => ({ oid, dist: 0 }));
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index]!;
      if (distances.has(item.oid)) continue;
      const object = lookup(item.oid);
      if (!object || object.type !== 'commit') continue;
      distances.set(item.oid, item.dist);
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: item.dist + 1 });
    }
    let current = 0;
    for (const oid of clientShallow) {
      const dist = distances.get(oid);
      if (dist !== undefined) current = Math.max(current, dist + 1);
    }
    effectiveDepth = current + depth;
  }

  // The depth-limited commit closure: distance 0 is the tip itself.
  const included = new Set<string>();
  const cutoff = new Set<string>();
  const walkQueue: Array<{ oid: string; dist: number }> = tips.map((oid) => ({ oid, dist: 0 }));
  const seen = new Set<string>();
  for (let index = 0; index < walkQueue.length; index += 1) {
    const item = walkQueue[index]!;
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    const object = lookup(item.oid);
    if (!object || object.type !== 'commit') continue;
    if (effectiveDepth !== null && item.dist >= effectiveDepth) continue;
    included.add(item.oid);
    if (effectiveDepth !== null && item.dist === effectiveDepth - 1) cutoff.add(item.oid);
    for (const parent of parseCommit(object.data).parents) walkQueue.push({ oid: parent, dist: item.dist + 1 });
  }

  // Everything the client already holds: its haves, fully, except past a
  // shallow boundary (a shallow clone holds the boundary commit and its tree,
  // not the boundary's parents — those are exactly what a deepen delivers).
  const held = collectHeld(haves, new Set(clientShallow), lookup);

  // The objects to send: each included commit's own tree closure, minus held.
  // The closure is tree-only on purpose: expanding a commit to its parents
  // would undo the depth limit (a shallow clone would carry its whole
  // history, and a deepen would find everything already held).
  const send = new Set<string>();
  for (const oid of tagObjects) if (!held.has(oid)) send.add(oid);
  for (const oid of included) {
    for (const reached of collectTreeObjects(oid, lookup)) if (!held.has(reached)) send.add(reached);
  }
  const objects: GitObject[] = [...send]
    .sort()
    .map((oid) => lookup(oid)!)
    .filter((object) => object !== undefined);

  // Acknowledgments: a have is common when it is reachable from a want.
  // With no haves there is nothing to acknowledge, so the walk is skipped.
  const acks: string[] = [];
  if (haves.length > 0) {
    const wantedReachable = new Set<string>();
    for (const tip of tips) {
      try {
        for (const oid of collectReachable([tip], lookup, { allowMissing: true })) wantedReachable.add(oid);
      } catch {
        // ignore
      }
    }
    for (const have of haves) if (wantedReachable.has(have)) acks.push(`ACK ${have}`);
  }
  if (acks.length > 0) acks.push('ready');
  else acks.push('NAK');

  // Shallow boundaries after this fetch.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null || clientShallow.length > 0) {
    const sentCommits = new Set<string>();
    for (const oid of send) {
      const object = lookup(oid);
      if (object && object.type === 'commit') sentCommits.add(oid);
    }
    for (const oid of cutoff) if (sentCommits.has(oid)) shallow.push(oid);
    for (const oid of clientShallow) {
      const object = lookup(oid);
      if (!object || object.type !== 'commit') {
        shallow.push(oid);
        continue;
      }
      const parents = parseCommit(object.data).parents;
      // A boundary stays shallow only while a parent of it is still missing:
      // a commit with no parents at all is fully known, so it unshallows.
      const stillCut = parents.some((parent) => !sentCommits.has(parent));
      if (stillCut) {
        if (!shallow.includes(oid)) shallow.push(oid);
      } else {
        unshallow.push(oid);
      }
    }
  }
  return { objects, acks, shallow, unshallow };
}

/** Split a pack into sideband band-1 packets of at most 32 KiB of pack each. */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** Answer a v2 fetch: acknowledgments, shallow-info, then the packfile. */
function fetchV2(repo: Repo, store: Store, body: Buffer): Buffer {
  const args = parseFetchArgs(body);
  const plan = planFetch(repo, store, args);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client offered haves:
  // with no haves there is nothing to negotiate, and a real server answers
  // with the shallow-info or packfile section straight away.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    for (const line of plan.acks) parts.push(pktLine(`${line}\n`));
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // The packfile section is always sent, even when nothing is new: the client
  // expects it after a fetch command, and an empty pack (zero objects) is the
  // way "nothing to send" is framed.
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPack(writePack(plan.objects))) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v0 fetch: NAK/ACK and shallow lines, then the sideband pack. */
function fetchV0(repo: Repo, store: Store, body: Buffer): Buffer {
  const plan = planFetch(repo, store, parseFetchArgs(body));
  const parts: Buffer[] = [];
  for (const line of plan.acks) parts.push(pktLine(`${line}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  // The pack follows, even when it carries no objects: a v0 fetch with
  // nothing new is still answered with an empty pack, not with silence.
  for (const packet of sidebandPack(writePack(plan.objects))) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Dispatch a POST to git-upload-pack: ls-refs or fetch, v2 when requested. */
function uploadPack(repo: Repo, store: Store, body: Buffer, version2: boolean): Buffer {
  let command = '';
  try {
    for (const packet of decodePktLines(body).packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8');
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
      break;
    }
  } catch {
    throw new Error('malformed pkt-line in upload-pack request');
  }
  if (command === 'ls-refs') {
    if (!version2) throw new Error('ls-refs needs protocol v2');
    return lsRefs(repo, store, body);
  }
  if (command === 'fetch' || command === '') {
    return version2 ? fetchV2(repo, store, body) : fetchV0(repo, store, body);
  }
  throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: the command list, then the raw pack bytes. */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, consumed } = decodePktLines(body, { allowTrailing: true });
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const line = nul < 0 ? text : text.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isHex40(oldOid) || !isHex40(newOid) || !ref.startsWith('refs/')) {
      throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');
  return { commands, pack: body.subarray(consumed) };
}

/** Answer a receive-pack push, with the report-status stream in sideband. */
function receivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const lookup = store.lookup(repo);
  let commands: PushCommand[];
  let pack: Buffer;
  try {
    ({ commands, pack } = parsePush(body));
  } catch (err) {
    throw new Error(`malformed receive-pack request: ${(err as Error).message}`);
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      for (const [oid, object] of readPack(pack)) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.replace(/[\r\n]+/g, ' ').slice(0, 200);
    }
  }

  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    let verdict: { ok: boolean; reason: string } = { ok: true, reason: '' };
    if (!unpackOk) {
      verdict = { ok: false, reason: 'unpack failed' };
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      const current = repo.refs.get(command.ref);
      if (current === undefined) verdict = { ok: false, reason: 'remote ref does not exist' };
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        verdict = { ok: false, reason: 'old oid does not match' };
      } else {
        repo.refs.delete(command.ref);
      }
    } else {
      const object = lookup(command.newOid);
      if (!object) {
        verdict = { ok: false, reason: 'object not found' };
      } else if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') {
        verdict = { ok: false, reason: 'invalid object type' };
      } else if (command.ref.startsWith('refs/tags/') && object.type !== 'commit' && object.type !== 'tag') {
        verdict = { ok: false, reason: 'invalid object type' };
      } else if (command.oldOid === ZERO_OID) {
        if (repo.refs.has(command.ref)) verdict = { ok: false, reason: 'already exists' };
        else repo.refs.set(command.ref, command.newOid);
      } else {
        const current = repo.refs.get(command.ref);
        if (current === undefined) {
          verdict = { ok: false, reason: 'remote ref does not exist' };
        } else if (current !== command.oldOid) {
          verdict = { ok: false, reason: 'old oid does not match' };
        } else if (command.newOid === command.oldOid) {
          // A no-op update is accepted.
        } else if (!isAncestor(command.oldOid, command.newOid, lookup)) {
          verdict = { ok: false, reason: 'non-fast-forward' };
        } else {
          repo.refs.set(command.ref, command.newOid);
        }
      }
    }
    lines.push(verdict.ok ? `ok ${command.ref}` : `ng ${command.ref} ${verdict.reason}`);
  }

  // The report-status stream, pkt-lined inside sideband band 1, and a flush
  // at the outer level to end the stream.
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${line}\n`)])));
  parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktFlush()])));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- routing

/**
 * Handle one git smart-HTTP request. `suffix` is the path after
 * `/<owner>/<repo>.git` ("/info/refs", "/git-upload-pack", ...).
 * Returns true when the request was a git one (handled or refused here).
 */
export function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  suffix: string,
  body: Buffer,
): boolean {
  if (!isAuthenticated(req)) {
    sendJsonError(res, 401, 'Requires authentication');
    return true;
  }
  if (!store.viewer.isOwner(owner)) {
    sendJsonError(res, 404, 'Not Found');
    return true;
  }
  const repo = store.getRepo(repoName);
  if (suffix === '/info/refs') {
    if (repo === undefined) {
      sendJsonError(res, 404, 'Not Found');
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service');
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      sendBuffer(res, 200, UPLOAD_AD, version2 ? v2Advertisement() : v0Advertisement(service, repo, store));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, RECEIVE_AD, v0Advertisement(service, repo, store));
      return true;
    }
    sendJsonError(res, 400, 'Missing or unknown service');
    return true;
  }
  if (suffix === '/git-upload-pack') {
    if (repo === undefined) {
      sendJsonError(res, 404, 'Not Found');
      return true;
    }
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      sendBuffer(res, 200, UPLOAD_RESULT, uploadPack(repo, store, body, version2));
    } catch (err) {
      sendJsonError(res, 400, (err as Error).message);
    }
    return true;
  }
  if (suffix === '/git-receive-pack') {
    if (repo === undefined) {
      sendJsonError(res, 404, 'Not Found');
      return true;
    }
    try {
      sendBuffer(res, 200, RECEIVE_RESULT, receivePack(repo, store, body));
    } catch (err) {
      sendJsonError(res, 400, (err as Error).message);
    }
    return true;
  }
  return false;
}

/** The git path of a request URL, or null when it is not one. */
export function gitPathOf(
  url: string,
): { owner: string; repo: string; suffix: string } | null {
  const path = url.split('?')[0] ?? '';
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  return { owner: decodeURIComponent(match[1]!), repo: decodeURIComponent(match[2]!), suffix: match[3] ?? '' };
}
