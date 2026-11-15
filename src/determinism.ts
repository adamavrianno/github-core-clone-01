// Determinism helpers: every timestamp the forge emits and every random
// choice it could make derive from the trial's environment variables, never
// from the wall clock and never from an unseeded source. A live trial and its
// replay therefore see identical bytes.
//
// MAKEFUN_TRIAL_NOW is the trial's fixed opening time (an ISO string, or a
// millisecond epoch). MAKEFUN_TRIAL_SEED is the trial's seed string. Both are
// set by the harness; when they are absent the forge falls back to the
// scenario epoch (2025-01-01T00:00:00Z) and a fixed seed, so a local run
// without the harness still behaves deterministically.

/** The scenario epoch: 2025-01-01T00:00:00Z, in milliseconds. */
export const DEFAULT_TRIAL_NOW_MS = 1735689600000;

/** The fixed seed used when MAKEFUN_TRIAL_SEED is absent. */
export const DEFAULT_TRIAL_SEED = 'github-core-clone-01';

/** One trial's clock: a single instant, read once at startup. */
export interface TrialClock {
  /** The trial instant in milliseconds since the epoch. */
  readonly nowMs: number;
  /** The trial instant in whole seconds since the epoch (git commit time). */
  readonly nowSec: number;
  /** The trial instant as an ISO 8601 string (merged_at, created_at). */
  readonly nowIso: string;
}

/** Parse MAKEFUN_TRIAL_NOW (ISO string or millisecond epoch) into a clock. */
export function trialClockFromEnv(env: Record<string, string | undefined>): TrialClock {
  const raw = env.MAKEFUN_TRIAL_NOW;
  let ms = DEFAULT_TRIAL_NOW_MS;
  if (raw !== undefined && raw !== '') {
    if (/^-?\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) ms = parsed;
    } else {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) ms = parsed;
    }
  }
  const nowSec = Math.floor(ms / 1000);
  return { nowMs: ms, nowSec, nowIso: new Date(ms).toISOString() };
}

/**
 * A seeded pseudo-random generator (FNV-1a over the seed text, then
 * mulberry32). The forge makes no random choice on any request path today;
 * this exists so any future one is seeded from MAKEFUN_TRIAL_SEED instead of
 * Math.random. Deterministic for a given seed string.
 */
export function makeSeededRng(seedText: string): () => number {
  let state = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i += 1) {
    state ^= seedText.charCodeAt(i);
    state = Math.imul(state, 0x01000193);
  }
  let a = state >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The trial seed string, from MAKEFUN_TRIAL_SEED or the fixed default. */
export function trialSeedFromEnv(env: Record<string, string | undefined>): string {
  const raw = env.MAKEFUN_TRIAL_SEED;
  return raw !== undefined && raw !== '' ? raw : DEFAULT_TRIAL_SEED;
}
