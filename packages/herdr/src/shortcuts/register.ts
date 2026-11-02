import { matchesKey, type KeyId } from '@earendil-works/pi-tui';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Disposable, HerdrViews } from '../contracts.js';
import { HERDR_NOTICES, herdrErrorNotice } from '../notices.js';
import { HerdrError } from '../client/parse.js';
const viewNotices = { agents: HERDR_NOTICES.viewAgents, todos: HERDR_NOTICES.viewTodos, usage: HERDR_NOTICES.viewUsage, memory: HERDR_NOTICES.viewMemory, triggers: HERDR_NOTICES.viewTriggers } as const;
export const HERDR_SHORTCUTS = [
  { key: 'ctrl+shift+a', view: 'agents', bytes: '\u001b[97;6u' },
  { key: 'ctrl+shift+o', view: 'todos', bytes: '\u001b[111;6u' },
  { key: 'ctrl+shift+u', view: 'usage', bytes: '\u001b[117;6u' },
  { key: 'ctrl+shift+m', view: 'memory', bytes: '\u001b[109;6u' },
  { key: 'ctrl+shift+k', view: 'triggers', bytes: '\u001b[107;6u' },
] as const;
export function registerHerdrShortcuts(pi: ExtensionAPI, views: HerdrViews): Disposable {
  let disposed = false;
  for (const { key, view } of HERDR_SHORTCUTS) {
    pi.registerShortcut(key, { description: `Open spider ${view}`, handler: async ctx => {
      if (disposed) return;
      try { await views[view](ctx); }
      catch (error) { ctx.ui.notify(error instanceof HerdrError ? herdrErrorNotice(error) : viewNotices[view].text, 'error'); }
    } });
  }
  // Pi unregisters keys when replacing the extension runtime; retained callbacks are inert.
  return { dispose() { disposed = true; } };
}


export interface ShortcutCollision { key: string; action: string; scope: 'tree' | 'editor' }
export function inspectHerdrShortcutCollisions(bindings: Readonly<Record<string, string | readonly string[]>>): ShortcutCollision[] {
  return Object.entries(bindings).flatMap(([action, bound]) => {
    const keys = typeof bound === 'string' ? [bound] : bound;
    return HERDR_SHORTCUTS.filter(shortcut => keys.some(key => matchesKey(shortcut.bytes, key as KeyId)))
      .map(shortcut => ({ key: shortcut.key, action, scope: action.startsWith('app.tree.') ? 'tree' as const : 'editor' as const }));
  });
}
