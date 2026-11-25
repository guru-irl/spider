// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_MODEL_SEEDS, checkpointModelSeed } from './checkpoint-model-seed.js';

describe('checkpoint model seed choice', () => {
  it('replays the seed named by SPIDER_TEST_SEED', () => {
    expect(checkpointModelSeed({ SPIDER_TEST_SEED: '305419896', GITHUB_RUN_ID: '7' })).toBe(305419896);
    expect(checkpointModelSeed({ SPIDER_TEST_SEED: '99' })).toBe(99);
  });

  it('rejects a replay seed that is not a 32-bit unsigned integer', () => {
    for (const bad of ['-1', '1.5', 'abc', '4294967296', ' 7'])
      expect(() => checkpointModelSeed({ SPIDER_TEST_SEED: bad }), bad).toThrow(/SPIDER_TEST_SEED/);
  });

  it('covers every known seed across consecutive CI runs', () => {
    const picked = Array.from({ length: CHECKPOINT_MODEL_SEEDS.length },
      (_, index) => checkpointModelSeed({ GITHUB_RUN_ID: String(41_000 + index) }));
    expect([...new Set(picked)].sort((a, b) => a - b)).toEqual([...CHECKPOINT_MODEL_SEEDS].sort((a, b) => a - b));
  });

  it('keeps the seed when a CI run is retried', () => {
    expect(checkpointModelSeed({ GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2' }))
      .toBe(checkpointModelSeed({ GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1' }));
  });

  it('picks a known seed outside CI', () => {
    expect(CHECKPOINT_MODEL_SEEDS).toContain(checkpointModelSeed({}));
    expect(CHECKPOINT_MODEL_SEEDS).toContain(checkpointModelSeed({ GITHUB_RUN_ID: 'not-a-number' }));
  });
});
