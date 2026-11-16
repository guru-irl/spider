// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import type { AppPaneCapabilities } from './types.js';
interface Command { name: string; args: { name: string; required: boolean }[] }
export function readAppPaneCapabilities(commands: unknown): AppPaneCapabilities {
  const value = commands && typeof commands === 'object' && !Array.isArray(commands) ? (commands as { commands?: unknown }).commands : commands;
  let normalized: Command[] = [];
  try {
    if (!Array.isArray(value) || value.length > 4096) throw new Error();
    normalized = value.map(row => {
      if (!row || typeof row.name !== 'string' || /[\x00-\x1f\x7f]/.test(row.name) || !Array.isArray(row.args)) throw new Error();
      const args = row.args.map((arg: unknown) => {
        if (!arg || typeof arg !== 'object') throw new Error();
        const a = arg as { name?: unknown; required?: unknown };
        if (typeof a.name !== 'string' || !a.name || typeof a.required !== 'boolean') throw new Error();
        return { name: a.name, required: a.required };
      }).sort((a: Command['args'][number], b: Command['args'][number]) => a.name.localeCompare(b.name));
      if (new Set(args.map((a: Command['args'][number]) => a.name)).size !== args.length) throw new Error();
      return { name: row.name, args };
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (new Set(normalized.map(c => c.name)).size !== normalized.length) throw new Error();
  } catch { normalized = []; }
  const has = (command: string, ...args: string[]) => {
    const row = normalized.find(c => c.name === command); return !!row && args.every(name => row.args.some(a => a.name === name));
  };
  return { backgroundTabCreation: has('tab.new', 'focus'), explicitTargetSwap: has('pane.swap', 'pane', 'target'),
    // Structured commands cannot prove behavioural focus preservation.
    noFocusConversion: false, commandDigest: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
}
