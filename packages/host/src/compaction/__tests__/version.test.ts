import { test, expect, vi } from 'vitest';
const tested = vi.hoisted(() => ({ version: '1.2.0' }));
vi.mock('@earendil-works/pi-coding-agent', async importOriginal => ({
  ...await importOriginal<object>(), get VERSION() { return tested.version; },
}));
import { registerCompaction } from '../index.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Break: a verified upgrade still warns, or an unverified upgrade silently suppresses the parity gate.
test.each([
  ['0.87.0', false], ['0.87.1', false], ['1.2.0', false],
  ['0.88.0', true], ['1.2.1', true], ['1.3.0', true],
] as const)('pi %s warns only when unverified (%s) and registers only the child draft path', (version, warning) => {
  tested.version = version;
  vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const names: string[] = [];
  try {
    registerCompaction({ on: (name: string) => { names.push(name); } } as unknown as ExtensionAPI, { readConfig: () => ({}) });
    const output = write.mock.calls.map(call => call[0]).join('');
    if (warning) {
      expect(output).toContain(`running ${version}, re-run the fuzz`);
    } else expect(output).toBe('');
    expect(names).toContain('turn_end'); expect(names).not.toContain('agent_end'); expect(names).not.toContain('session_before_compact');
  } finally { write.mockRestore(); }
});
