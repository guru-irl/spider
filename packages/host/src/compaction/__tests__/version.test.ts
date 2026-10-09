import { test, expect, vi } from 'vitest';
vi.mock('@earendil-works/pi-coding-agent', async importOriginal => ({
  ...await importOriginal<object>(), VERSION: '0.88.0',
}));
import { registerCompaction } from '../index.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// Break: upgrade warning disappears, or an unsupported pi version prevents registration entirely.
test('unsupported pi version warns to rerun fuzz and still registers only the child draft path', () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const names: string[] = [];
  try {
    registerCompaction({ on: (name: string) => { names.push(name); } } as unknown as ExtensionAPI, { readConfig: () => ({}) });
    expect(write.mock.calls.map(call => call[0]).join('')).toMatch(/mirrored pi 0\.87 internals; running 0\.88\.0, re-run the fuzz/);
    expect(names).toContain('turn_end'); expect(names).not.toContain('agent_end'); expect(names).not.toContain('session_before_compact');
  } finally { write.mockRestore(); }
});
