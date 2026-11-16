// The entry's life, from the harness's side: bind, register, wait, exit.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing
//      to register with, so the process exits 1 at once.
//   2. The server binds an ephemeral port (listen(0)). 8080 belongs to the
//      env and is never bound here.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. 200 means the env took
//      the port; 409 means another entry registered first, and this process
//      waits like any other. Anything else is retried with a backoff, since
//      the env may still be starting.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once, so this is a poll. The process never exits before
//      the env says done.
//   5. Close the server and exit 0.
//
// The server itself lives in app.ts; this file only runs the harness dance.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first and longest waits between retries. */
const RETRY_FIRST_MS = 250;
const RETRY_LAST_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after a failed attempt: exponential from RETRY_FIRST_MS, capped. */
function retryWait(attempt: number): number {
  return Math.min(RETRY_LAST_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or says another entry won (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryWait(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(retryWait(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
