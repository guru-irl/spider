// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { SESSION_PROGRAM } from '../../../herdr/src/sessions/launcher.js';
export async function resolvePaneAgentProgram(key: string, exists: (program: string) => Promise<boolean>): Promise<readonly string[]> {
  if (key !== SESSION_PROGRAM) throw new HerdrError('unknown-agent', 'Agent key is not configured for session launch');
  if (!await exists(SESSION_PROGRAM)) throw new HerdrError('agent-program-missing', 'Configured agent program is missing on the selected machine');
  return [SESSION_PROGRAM];
}
