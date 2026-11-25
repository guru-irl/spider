// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { checkpointModelSeed } from './checkpoint-model-seed.js';
import { registerCheckpointModelSeed } from './setup-checkpoint-model.js';

// One known seed per CI run; successive runs cover them all. To replay a
// failure, set SPIDER_TEST_SEED to the seed in the failing test's name.
registerCheckpointModelSeed(checkpointModelSeed(process.env));
