import { vi } from 'vitest';
import type { HerdrCliPorts } from '../../../herdr/src/setup/cli.js';

export function configFixtureCwd<T extends Pick<HerdrCliPorts, 'request'>>(ports: T, cwd: string): T {
  const request = ports.request;
  ports.request = async path => {
    const location = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try { return await request(path); } finally { location.mockRestore(); }
  };
  return ports;
}
