// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';

const state = vi.hoisted(() => ({ reason: 'Remote execution failed because its connection could not be established.' }));
vi.mock('../herdr/mount.js', () => ({ mountHerdr: () => ({ enabled: () => false, execution: () => ({ remoteUnavailableReason: state.reason }), guard: async () => undefined, dispose: async () => {} }) }));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('the registered exec action preserves the activation cause without the tool guard', async () => {
  const { default: extension } = await import('../extension.js');
  const { getAction, clearActions } = await import('../dispatch.js');
  const pi = { on() { return () => {}; }, registerTool() {}, registerCommand() {}, registerShortcut() {} };
  try {
    extension(withPiEvents(pi as never), hostUnitPorts);
    expect(() => getAction('exec')!({ action: 'exec', on: 'remote.invalid', language: 'shell', code: 'true' }, {} as never)).toThrow(state.reason);
    expect(() => getAction('exec')!({ action: 'exec', on: 'remote.invalid' }, {} as never)).toThrow(expect.objectContaining({ code: 'herdr-unavailable' }));
  } finally { clearActions(); }
});
