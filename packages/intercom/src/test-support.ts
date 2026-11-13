import { afterAll, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
const scratch = resolve('.spider/scratch/i');
mkdirSync(scratch, { recursive: true });
const agent = mkdtempSync(join(scratch, 'a-'));
const prior = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
afterAll(() => {
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prior;
  rmSync(agent, { recursive: true, force: true });
});
export function testTmpDir(): string { return scratch; }
export default function test(name: string, optionsOrBody: { concurrency?: boolean; timeout?: number; skip?: boolean } | (() => unknown), body?: () => unknown): void {
  const run = typeof optionsOrBody === "object" && optionsOrBody.skip ? it.skip : it;
  run(name, body ?? optionsOrBody as () => unknown, 5000);
}
