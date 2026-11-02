// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HerdrConfig, MachineName, MachineRuntime } from './contracts.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HerdrError, object, text, absolutePath } from './client/parse.js';
function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new HerdrError('invalid-config', 'Expected a list'); return value; }
function limit(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new HerdrError('invalid-config', 'Configured limit is out of range'); return value;
}
function wrapperIdentity(value: unknown): HerdrConfig['admin']['wrappers'][number] {
  if (typeof value === 'string') {
    const path = absolutePath(value);
    let current: string;
    try { current = createHash('sha256').update(readFileSync(path)).digest('hex'); }
    catch { throw new HerdrError('invalid-config', `Admin wrapper ${JSON.stringify(path)} requires {path, sha256}; cannot read wrapper to compute its current sha256`); }
    throw new HerdrError('invalid-config', `Admin wrapper ${JSON.stringify(path)} requires {path, sha256}. Review the file before approving it. Current sha256: ${current}`);
  }
  const wrapper = object(value), path = absolutePath(wrapper.path);
  if (typeof wrapper.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(wrapper.sha256))
    throw new HerdrError('invalid-config', 'Wrapper sha256 must be 64 lowercase hexadecimal characters');
  return { path, sha256: wrapper.sha256 };
}
export function parseHerdrConfig(value: unknown): HerdrConfig {
  const c = object(value); const app = object(c.app), core = object(c.core);
  const limits = object(c.limits ?? {}), retention = object(c.retention ?? {}), admin = object(c.admin ?? {});
  if (c.enabled !== undefined && c.enabled !== 'auto' && typeof c.enabled !== 'boolean') throw new HerdrError('invalid-config', 'enabled must be auto or boolean');
  const spaces = list(c.spaces).map(value => {
    const s = object(value); return { name: text(s.name), sessions: list(s.sessions).map(value => {
      const selector = object(value);
      if (selector.file !== undefined) return { file: absolutePath(selector.file) };
      return { name: text(selector.name), ...(selector.sessionId === undefined ? {} : { sessionId: text(selector.sessionId) }) };
    }) };
  });
  const machines = list(c.machines).map(value => {
    const m = object(value), r = object(m.runtime), commands = object(r.commands);
    const parsedCommands: Record<string, readonly string[]> = {};
    for (const [language, command] of Object.entries(commands)) parsedCommands[language] = list(command).map(text);
    const runtime: MachineRuntime = { cwd: r.cwd === null || r.cwd === undefined ? null : absolutePath(r.cwd), directory: absolutePath(r.directory), commands: parsedCommands };
    return { name: text(m.name) as MachineName, aliases: list(m.aliases ?? []).map(text), runtime, ...(m.nodePath === undefined ? {} : { nodePath: absolutePath(m.nodePath) }) };
  });
  let fonts: HerdrConfig['fonts'];
  if (c.fonts !== undefined) {
    const f = object(c.fonts); fonts = {};
    for (const kind of ['body', 'label', 'paths'] as const) if (f[kind] !== undefined) {
      const font = object(f[kind]); fonts[kind] = { path: absolutePath(font.path), license: absolutePath(font.license) };
    }
  }
  return { enabled: c.enabled === undefined ? 'auto' : c.enabled as 'auto' | boolean,
    app: { binary: absolutePath(app.binary), home: absolutePath(app.home) }, core: { binary: absolutePath(core.binary), config: absolutePath(core.config) },
    agentDirectory: absolutePath(c.agentDirectory), globalRoot: absolutePath(c.globalRoot), shellRc: absolutePath(c.shellRc), spaces, machines,
    ...(fonts ? { fonts } : {}), limits: { auxiliaryPanes: limit(limits.auxiliaryPanes, 2, 1, 6), completedRows: limit(limits.completedRows, 50, 1, 10000), completedHours: limit(limits.completedHours, 24, 1, 8760) },
    retention: { foregroundDays: limit(retention.foregroundDays, 7, 1, 3650) }, admin: { wrappers: list(admin.wrappers ?? []).map(wrapperIdentity) } };
}
