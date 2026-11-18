// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { waitFor, type Deadline } from '../harness/wait.js';

export interface OwnedSteer { cwd: string; runId: string; message: string }

export async function waitForOwnedSteer(target: OwnedSteer, limit: Deadline, started: () => Promise<boolean>): Promise<void> {
  await waitFor(`owned steer reaches child ${target.runId}: ${target.message}`, started, Boolean, limit);
}
