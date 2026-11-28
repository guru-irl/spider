// packages/ui/src/components/spinner.ts
import { ACTIVITY_FRAMES, ROBOT_FRAMES, SPINNER_FRAMES, type IconStyle } from "../icons.js";
export const BRAILLE_FRAMES: string[] = [...SPINNER_FRAMES.nerd];

export class Spinner {
  private frames: readonly string[];
  private intervalMs: number;
  constructor(opts: { frames?: string[]; intervalMs?: number; iconStyle?: IconStyle } = {}) {
    this.frames = opts.frames ?? SPINNER_FRAMES[opts.iconStyle ?? "text"];
    this.intervalMs = opts.intervalMs ?? 100;
  }
  frame(now: number = Date.now()): string {
    const i = Math.floor(now / this.intervalMs) % this.frames.length;
    return this.frames[i];
  }
}

export const MOON_CYCLE_MS = 1000;

export function moonFrame(style: IconStyle, elapsed?: number): string {
  const { idle, working } = ACTIVITY_FRAMES[style];
  return elapsed === undefined ? idle : working[Math.floor(elapsed * working.length / MOON_CYCLE_MS) % working.length];
}

const ROBOT_BEATS = [
  ["center", 700], ["left", 350], ["center", 200], ["right", 350],
  ["center", 700], ["closed", 120], ["center", 250], ["closed", 120],
] as const;
const ROBOT_CYCLE_MS = ROBOT_BEATS.reduce((total, [, duration]) => total + duration, 0);
const PULSE_CYCLE_MS = 1800;

function runPhase(runId: string, elapsed: number, cycle: number): number {
  let hash = 2166136261;
  for (let i = 0; i < runId.length; i++) hash = Math.imul(hash ^ runId.charCodeAt(i), 16777619);
  return (elapsed + (hash >>> 0) % cycle) % cycle;
}

export function robotFrame(runId: string, elapsed: number): string {
  let phase = runPhase(runId, elapsed, ROBOT_CYCLE_MS);
  for (const [frame, duration] of ROBOT_BEATS) {
    if (phase < duration) return ROBOT_FRAMES[frame];
    phase -= duration;
  }
  return ROBOT_FRAMES.center;
}

export function robotPulse(runId: string, elapsed: number): number {
  const phase = runPhase(runId, elapsed, PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}
