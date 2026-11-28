// packages/ui/src/components/spinner.ts
import { ACTIVITY_FRAMES, SPINNER_FRAMES, type IconStyle } from "../icons.js";
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
