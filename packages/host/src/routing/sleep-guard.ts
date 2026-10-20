// Ported from https://github.com/michael-denyer/pstack-claude,
// plugins/pstack/pi/agent-tools.ts at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import { hasRunningChildren } from "@spider/subagents";
import { isExecWait } from "./exec-wait";
import { SPIDER_TOOL_NAME } from "./tracking";

const SLEEP_BLOCKED =
  "Blocked: a subagent from this session is still running, and its completion notice arrives on its own. Do not sleep or poll for it. Continue other work, or end your turn; the notice starts your next one. To wait for external work such as CI or a deploy, use spider schedule.";

function commandWait(command: any): boolean {
  return isExecWait(command?.language, command?.code);
}

export function guardForegroundSleep(input: any, sessionId: string, toolName: string = SPIDER_TOOL_NAME): { block: true; reason: string } | undefined {
  // Do not inspect command text or read a DB when this session has no live child.
  if (!hasRunningChildren(sessionId)) return;
  // background:true still waits without a timeout. With one it waits until the
  // deadline before detaching, so neither form exempts a foreground-shaped sleep.
  // A batch never detaches, even if it is passed background:true.
  if (toolName !== SPIDER_TOOL_NAME && toolName !== "spider_exec") return;
  const waits = toolName === "spider_exec" || input?.action === "exec" ? commandWait(input)
    : input?.action === "exec_file" ? input.language === "shell" && commandWait(input)
    : input?.action === "batch" && Array.isArray(input.commands) && input.commands.some(commandWait);
  if (waits) return { block: true, reason: SLEEP_BLOCKED };
}
