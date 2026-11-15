// The forge's entry point: bind an ephemeral port, register it with the
// suite, serve until the suite says it is done, then exit 0.
//
// Lifecycle (the trial's wire contract): the harness starts this program
// with MAKEFUN_ENV_URL (the suite's origin), MAKEFUN_SHOP_TOKEN (the bearer
// token every request carries), MAKEFUN_TRIAL_SEED and MAKEFUN_TRIAL_NOW.
// The program listens on an ephemeral port of its own choosing, POSTs
// {"port": N} to $MAKEFUN_ENV_URL/register, then long-polls GET
// $MAKEFUN_ENV_URL/done until {"done": true} and exits 0.
//
// Without MAKEFUN_ENV_URL (a local run) it serves until it is killed.
// Node 22+, standard library only, one process, no network beyond the suite.

import { createForgeServer } from './src/server.ts';
import { ForgeStore } from './src/store.ts';
import { trialClockFromEnv } from './src/determinism.ts';

const REGISTER_PATH = '/register';
const DONE_PATH = '/done';
const POLL_MS = 500;
const REGISTER_ATTEMPTS = 25;
const REGISTER_RETRY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** POST {"port"} to the env's /register; true on a 2xx answer. */
async function register(envUrl: string, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}${REGISTER_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return true;
      if (response.status === 409) return false; // another entry already registered
    } catch {
      // The env may not be listening yet; retry.
    }
    await sleep(REGISTER_RETRY_MS);
  }
  return false;
}

/** Long-poll GET /done until the suite answers {"done": true}. */
async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}${DONE_PATH}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 200) {
        const body = (await response.json().catch(() => null)) as { done?: unknown } | null;
        if (body !== null && body.done === true) return;
      }
    } catch {
      // A transient failure is not the end of the trial; keep polling.
    }
    await sleep(POLL_MS);
  }
}

async function main(): Promise<number> {
  const env = process.env as Record<string, string | undefined>;
  const token = env.MAKEFUN_SHOP_TOKEN ?? '';
  const envUrl = (env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const clock = trialClockFromEnv(env);
  const store = new ForgeStore(clock);
  const server = createForgeServer(store, { token, host: '0.0.0.0', port: 0 });

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const info = server.address();
      if (info === null || typeof info === 'string') {
        reject(new Error('the server bound no TCP address'));
        return;
      }
      resolve({ port: info.port });
    });
  });

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  if (envUrl === '') {
    process.stderr.write(`forge listening on 0.0.0.0:${address.port} (no MAKEFUN_ENV_URL: serving until killed)\n`);
    return new Promise<number>(() => undefined); // never resolves; signals exit
  }

  const registered = await register(envUrl, address.port);
  if (!registered) {
    process.stderr.write('forge: could not register with the suite\n');
    server.close();
    return 1;
  }
  await waitForDone(envUrl);
  server.close();
  return 0;
}

const code = await main();
process.exit(code);
