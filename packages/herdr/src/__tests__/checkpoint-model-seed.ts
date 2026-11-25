// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

/**
 * Seeds for the checkpoint model test. Each used to run in its own test
 * file on every CI run. One runs per CI run now, and successive runs cover
 * them all.
 */
export const CHECKPOINT_MODEL_SEEDS: readonly number[] = [1, 17, 182, 116, 4093, 65537, 305419896, 3735928559];

const MAX_SEED = 0xffff_ffff;

/**
 * Chooses the checkpoint model seed for this run. `SPIDER_TEST_SEED`
 * replays a failure (every test name includes its seed). In CI the run ID
 * picks the seed, so a retried run keeps it; elsewhere the day of the month
 * does.
 */
export function checkpointModelSeed(env: Readonly<Record<string, string | undefined>>): number {
  const replay = env.SPIDER_TEST_SEED;
  if (replay !== undefined && replay !== '') {
    if (!/^\d+$/.test(replay) || Number(replay) > MAX_SEED)
      throw new Error(`SPIDER_TEST_SEED must be an integer from 0 to ${MAX_SEED}, got "${replay}"`);
    return Number(replay);
  }
  const run = /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? Number(env.GITHUB_RUN_ID) : new Date().getUTCDate();
  return CHECKPOINT_MODEL_SEEDS[run % CHECKPOINT_MODEL_SEEDS.length]!;
}
