// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { HerdrError } from '../client/parse.js';

export function exactLaunchArgv(shell: string, pi: string, file: string, limits: { soft: number; hard: number },
  paths: { globalRoot: string; agentDirectory: string; handoffFile: string }): readonly string[] {
  const valid = (value: number) => value === Infinity || Number.isSafeInteger(value) && value >= 0;
  if (!valid(limits.soft) || !valid(limits.hard) || limits.soft > limits.hard) {
    throw new HerdrError('launch-limits-invalid', 'Cannot verify the destination file limit');
  }
  const target = Math.min(limits.hard, Math.max(limits.soft, 65_536));
  const script = 'ulimit -Sn "$1" && shift && export SPIDER_GLOBAL_ROOT="$1" PI_CODING_AGENT_DIR="$2" SPIDER_HERDR_HANDOFF_FILE="$3" && unset SPIDER_HERDR_HANDOFF_OPERATION_ID SPIDER_HERDR_HANDOFF_NONCE SPIDER_HERDR_LEASE_TOKEN SPIDER_HERDR_LEASE_FILE SPIDER_HERDR_SSH_BYPASS PI_SUBAGENT_CHILD && shift 3 && exec "$@"';
  return [shell, '-c', script, shell, target === Infinity ? 'unlimited' : String(target),
    paths.globalRoot, paths.agentDirectory, paths.handoffFile, pi, '--session', file];
}
