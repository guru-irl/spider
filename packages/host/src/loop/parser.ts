// Ported from https://github.com/michael-denyer/pstack-claude,
// plugins/pstack/pi/schedule.ts at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer

// setInterval treats a delay above 2^31-1 ms as 1 ms.
const MAX_LOOP_S = 24 * 86400;

export type LoopCommand =
  | { kind: "stop" }
  | { kind: "usage"; reason?: string }
  | { kind: "fixed"; seconds: number; prompt: string }
  | { kind: "dynamic"; prompt: string };

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseLoop(args: string): LoopCommand {
  const text = args.trim();
  if (!text) return { kind: "usage" };
  if (text === "stop") return { kind: "stop" };
  const m = /^(\d+)([smhd])(?:\s+([\s\S]+))?$/.exec(text);
  if (m) {
    const seconds = Number(m[1]) * UNIT_SECONDS[m[2]];
    if (!m[3]) return { kind: "usage" };
    if (seconds > MAX_LOOP_S) return { kind: "usage", reason: "Intervals over 24 days are not supported." };
    return { kind: "fixed", seconds, prompt: m[3].trim() };
  }
  return { kind: "dynamic", prompt: text };
}
