import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('writes managed guidance to the agent directory pi reads', async () => {
  const scratch = join(process.cwd(), '.spider/scratch/tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'agents-dir-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const cases = [
    { configured: join(root, 'custom-agent'), expected: join(root, 'custom-agent', 'AGENTS.md') },
    { configured: '~/alternate-agent', expected: join(home, 'alternate-agent', 'AGENTS.md') },
    { configured: '~', expected: join(home, 'AGENTS.md') },
    { configured: undefined, expected: join(home, '.pi', 'agent', 'AGENTS.md') },
    { configured: '', expected: join(home, '.pi', 'agent', 'AGENTS.md') },
  ];
  for (const { configured, expected } of cases) {
    vi.stubEnv('PI_CODING_AGENT_DIR', configured);
    vi.resetModules();
    const { registerSuperpowers } = await import('../index.js');
    registerSuperpowers({}, {}, {});
    expect(existsSync(expected), `guidance at ${expected}`).toBe(true);
    expect(readFileSync(expected, 'utf8')).toContain('<!-- spider:start -->');
    rmSync(expected);
  }
});
