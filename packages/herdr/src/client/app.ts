// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { setTimeout as delay } from 'node:timers/promises';
import type { AppClient, AppClientOptions, AppPaneInspection, AppReply, OwnerPlacement, PaneId, SpaceId, TabId, TerminalAddress } from '../contracts.js';
import { invokeCli } from './cli-transport.js';
import { HerdrError, object, text } from './parse.js';
function placements(value: unknown, address: TerminalAddress): OwnerPlacement[] {
  const doc = object(value);
  if (!Array.isArray(doc.spaces)) throw new HerdrError('app-disconnected', 'App layout document is unavailable');
  const found: OwnerPlacement[] = [];
  for (const value of doc.spaces) {
    const space = object(value); if (!Array.isArray(space.tabs)) throw new HerdrError('invalid-reply', 'Invalid app tabs');
    for (const value of space.tabs) {
      const tab = object(value); if (!Array.isArray(tab.terminals)) throw new HerdrError('invalid-reply', 'Invalid app terminals');
      for (const value of tab.terminals) {
        const terminal = object(value);
        if (terminal.terminal === address) found.push({ space: text(space.id) as SpaceId, tab: text(tab.id) as TabId, pane: text(terminal.pane) as PaneId });
      }
    }
  }
  return found;
}
export function createAppClient(options: AppClientOptions, operationSignal?: AbortSignal): AppClient & AppPaneInspection {
  const env = Object.freeze({ ...options.env });
  const call = (args: readonly string[], signal: AbortSignal | undefined = operationSignal) => invokeCli(options.binary, args, env, undefined, undefined, { signal });
  const tab = async (placement: Pick<OwnerPlacement, 'space' | 'tab'>) => {
    const layout = object(await call(['ls']));
    if (!Array.isArray(layout.spaces)) throw new HerdrError('app-disconnected', 'App layout document is unavailable');
    const matches: { rows: { terminal: TerminalAddress; pane: PaneId }[]; index: number }[] = [];
    for (const rawSpace of layout.spaces) {
      const space = object(rawSpace);
      if (space.id !== placement.space) continue;
      if (!Array.isArray(space.tabs)) throw new HerdrError('invalid-reply', 'Invalid app tabs');
      for (const [index, rawTab] of space.tabs.entries()) {
        const candidate = object(rawTab);
        if (candidate.id !== placement.tab) continue;
        if (!Array.isArray(candidate.terminals)) throw new HerdrError('invalid-reply', 'Invalid app terminals');
        matches.push({ index: index + 1, rows: candidate.terminals.flatMap(value => {
          const row = object(value);
          return row.pane == null ? [] : [{ terminal: text(row.terminal) as TerminalAddress, pane: text(row.pane) as PaneId }];
        }) });
      }
    }
    if (matches.length !== 1) throw new HerdrError(matches.length ? 'tab-ambiguous' : 'tab-unplaced', 'Tab has no unique observed layout');
    return matches[0];
  };
  return {
    tabPanes: async placement => (await tab(placement)).rows,
    tabIndex: async placement => (await tab(placement)).index,
    focusedPane: async () => {
      const value = object(await call(['status']));
      if (value.space == null || value.tab == null || value.focused_pane == null) return null;
      return { space: text(value.space) as SpaceId, tab: text(value.tab) as TabId, pane: text(value.focused_pane) as PaneId };
    },
    tabTerminals: async placement => {
      const layout = object(await call(['ls']));
      if (!Array.isArray(layout.spaces)) throw new HerdrError('app-disconnected', 'App layout document is unavailable');
      const matches: TerminalAddress[][] = [];
      for (const rawSpace of layout.spaces) {
        const space = object(rawSpace);
        if (space.id !== placement.space) continue;
        if (!Array.isArray(space.tabs)) throw new HerdrError('invalid-reply', 'Invalid app tabs');
        for (const rawTab of space.tabs) {
          const tab = object(rawTab);
          if (tab.id !== placement.tab) continue;
          if (!Array.isArray(tab.terminals)) throw new HerdrError('invalid-reply', 'Invalid app terminals');
          matches.push(tab.terminals.map(value => text(object(value).terminal) as TerminalAddress));
        }
      }
      if (matches.length !== 1) throw new HerdrError(matches.length ? 'owner-ambiguous' : 'owner-unplaced', 'Owner tab has no unique observed layout');
      return matches[0];
    },
    ownerPlacement: async address => {
      const rows = placements(await call(['ls']), address);
      if (rows.length !== 1) throw new HerdrError(rows.length ? 'owner-ambiguous' : 'owner-unplaced', 'Owner terminal has no unique observed pane'); return rows[0];
    },
    tabSpace: async id => {
      const doc = object(await call(['ls']));
      if (!Array.isArray(doc.spaces)) throw new HerdrError('app-disconnected', 'App layout document is unavailable');
      const found: SpaceId[] = [];
      for (const raw of doc.spaces) {
        const space = object(raw);
        if (!Array.isArray(space.tabs)) throw new HerdrError('invalid-reply', 'Invalid app tabs');
        if (space.tabs.some(rawTab => text(object(rawTab).id) === id)) found.push(text(space.id) as SpaceId);
      }
      if (found.length > 1) throw new HerdrError('owner-ambiguous', 'Tab appears in more than one space');
      return found[0] ?? null;
    },
    awaitPane: async (viewer, owner, { signal, timeoutMs }) => {
      const deadline = Date.now() + timeoutMs;
      do {
        if (signal?.aborted) throw new HerdrError('aborted', 'Pane acknowledgement aborted');
        const rows = placements(await call(['ls'], signal), viewer);
        if (rows.length === 1 && rows[0].space === owner.space && rows[0].tab === owner.tab) return rows[0].pane;
        const remaining = deadline - Date.now(); if (remaining <= 0) break;
        try { await delay(Math.min(100, remaining), undefined, { signal }); }
        catch { throw new HerdrError('aborted', 'Pane acknowledgement aborted'); }
      } while (Date.now() <= deadline);
      throw new HerdrError('pane-timeout', 'Viewer pane was not acknowledged in its owner tab');
    },
    command: async (name, args) => {
      const argv = ['do', name];
      for (const [key, value] of Object.entries(args)) argv.push(`--${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      let raw: unknown;
      try { raw = await call(argv); }
      catch (error) {
        if (!(error instanceof HerdrError) || error.code !== 'cli-exit') throw error;
        const details = object(error.details);
        try { raw = JSON.parse(text(details.stdout)); if (object(raw).error === undefined) throw error; }
        catch { throw error; }
      }
      const reply = object(raw);
      if (reply.error !== undefined) {
        if (typeof reply.error === 'string') return { error: { code: 'app-error', message: reply.error } };
        const error = object(reply.error); return { error: { code: typeof error.code === 'string' ? error.code : 'app-error', message: text(error.message) } };
      }
      const result: AppReply = {};
      if (reply.space !== undefined) result.space = text(reply.space) as SpaceId;
      if (reply.tab !== undefined) result.tab = text(reply.tab) as TabId;
      if (reply.pane !== undefined) result.pane = text(reply.pane) as PaneId;
      if (reply.terminal !== undefined) result.terminal = text(reply.terminal) as TerminalAddress;
      if (reply.pending !== undefined) { if (typeof reply.pending !== 'boolean') throw new HerdrError('invalid-reply', 'Invalid app acknowledgement'); result.pending = reply.pending; }
      return result;
    },
  };
}
