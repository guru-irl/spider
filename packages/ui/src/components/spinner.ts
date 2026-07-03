// packages/ui/src/components/spinner.ts
export const BRAILLE_FRAMES: string[] = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export class Spinner {
  private frames: string[];
  private intervalMs: number;
  constructor(opts: { frames?: string[]; intervalMs?: number } = {}) {
    this.frames = opts.frames ?? BRAILLE_FRAMES;
    this.intervalMs = opts.intervalMs ?? 100;
  }
  frame(now: number = Date.now()): string {
    const i = Math.floor(now / this.intervalMs) % this.frames.length;
    return this.frames[i];
  }
}
