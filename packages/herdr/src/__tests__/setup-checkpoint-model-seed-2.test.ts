// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { checkpointModelSeed } from './checkpoint-model-seed.js';
import { registerCheckpointModelSeed } from './setup-checkpoint-model.js';

registerCheckpointModelSeed(checkpointModelSeed(process.env), 2);
