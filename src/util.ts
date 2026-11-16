// Shared helpers that never touch the wall clock or an unseeded random source.
//
// Determinism is a scored property of this forge: a trial is replayed and the
// export must come out byte for byte the same. So every timestamp and every id
// the forge invents comes from a counter anchored at the trial's own "now"
// (MAKEFUN_TRIAL_NOW when the env sets it, a fixed epoch otherwise). Two runs
// of the same operations in the same order therefore produce the same bytes.

/** The trial's opening time, or a fixed fallback when the env does not set one. */
function anchorMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse('2026-11-16T00:00:00.000Z');
}

const ANCHOR_MS = anchorMs();

/** Logical ticks handed out, one per timestamp the forge mints. */
let tickCount = 0;

/**
 * The next timestamp as an ISO string: the anchor plus one second per tick.
 * Monotonic by construction, so created_at < updated_at always holds and two
 * runs mint the same stamps in the same order.
 */
export function tickIso(): string {
  tickCount += 1;
  return new Date(ANCHOR_MS + tickCount * 1000).toISOString();
}

/** The next timestamp as Unix seconds, for git commit and tag objects. */
export function tickEpochSec(): number {
  tickCount += 1;
  return Math.floor(ANCHOR_MS / 1000) + tickCount;
}

/** Monotonic sequence numbers for creation order (issues, repos, ...). */
let sequence = 0;
export function nextSequence(): number {
  sequence += 1;
  return sequence;
}

/** Request ids for the X-GitHub-Request-Id header: a plain counter, never random. */
let requestCount = 0;
export function nextRequestId(): string {
  requestCount += 1;
  return `req-${requestCount}`;
}

/** Database ids (the numeric `id` fields): one counter for every kind of object. */
let databaseCount = 0;
export function nextDatabaseId(): number {
  databaseCount += 1;
  return databaseCount;
}

/** Base64 of UTF-8 text (for the contents API's `content` field). */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 of raw bytes. */
export function b64encodeBytes(bytes: Buffer): string {
  return bytes.toString('base64');
}

/** Decode base64 to raw bytes; an empty string decodes to an empty buffer. */
export function b64decode(text: string): Buffer {
  if (text === '') return Buffer.alloc(0);
  return Buffer.from(text.replace(/\s/g, ''), 'base64');
}

/** True for a lowercase 40-hex git object id. */
export function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Base64url without padding, for opaque global (Relay) ids. */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url string, or null when it is not one. */
export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
