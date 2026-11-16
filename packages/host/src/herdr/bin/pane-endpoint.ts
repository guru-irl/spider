// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { openDbReadOnly } from '@spider/db-core';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerdrError } from '../../../../herdr/src/client/parse.js';
import { createHcClient, invokeCli, observeCoreIdentity } from '../../../../herdr/src/client/hc.js';
import { parseHerdrConfig } from '../../../../herdr/src/config.js';
import { sessionFeedIsFresh } from '../../../../herdr/src/feed/freshness.js';
import { encodeRemotePaneReply, paneId, parsePaneTerminal, parseRemotePaneRequest, PANE_REPLY_LIMIT } from '../../../../herdr/src/panes/codec.js';
import { createProcessPresence } from '../../../../herdr/src/sessions/presence.js';
import { createTerminalRegistry, readPrivateJson } from '../../../../herdr/src/sessions/registry.js';
import { parseFeed } from '../../../../herdr/assets/shared/feed.js';
import { processStartTime } from '../../../../subagents/src/process-identity.js';
import { createPaneSourceEffects } from '../pane-source.js';
import { handleRemotePaneRequest, readPaneSourceInventory, type PaneEndpointPorts, type PaneSourceInventoryPorts } from '../pane-endpoint.js';

export { stagePaneEndpointInstallation } from '../pane-installation.js';

/** Parse before creating any source resources, including the hc client. */
export async function runPaneEndpointCli(args: readonly string[], ports: () => Promise<PaneEndpointPorts>): Promise<string> {
  if (args.length !== 2 || args[0] !== '--json' || Buffer.byteLength(args[1]) > PANE_REPLY_LIMIT) throw new HerdrError('invalid-pane-command', 'Expected one bounded JSON request');
  let value: unknown;
  try { value = JSON.parse(args[1]); } catch { throw new HerdrError('invalid-pane-command', 'Expected valid JSON'); }
  const request = parseRemotePaneRequest(value);
  const endpoint = await ports();
  try { return encodeRemotePaneReply(await handleRemotePaneRequest(request, endpoint)); } finally { await endpoint.dispose?.(); }
}

/** Source effects remain lazy so handshake and malformed input need no source resources. */
export function createProductionPaneEndpointPorts(buildDigest: string, env: Readonly<NodeJS.ProcessEnv> = process.env, packageRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '../..')): PaneEndpointPorts {
  let sourcePromise: Promise<PaneSourceInventoryPorts> | undefined;
  let ownedClient: ReturnType<typeof createHcClient> | undefined;
  let effectsPromise: Promise<ReturnType<typeof createPaneSourceEffects>> | undefined;
  const effects = (): Promise<ReturnType<typeof createPaneSourceEffects>> => effectsPromise ??= (async () => {
    const p = await source();
    const config = parseHerdrConfig(JSON.parse(await readFile(join(env.SPIDER_GLOBAL_ROOT ?? join(homedir(), '.pi', 'agent', 'spider'), 'herdr/config.json'), 'utf8')));
    return createPaneSourceEffects({ config, source: p, hc: ownedClient ??= createHcClient({ binary: config.core.binary, env }), resolveOwner, packageRoot, env });
  })();
  const source = (): Promise<PaneSourceInventoryPorts> => sourcePromise ??= (async () => {
    const globalRoot = env.SPIDER_GLOBAL_ROOT ?? join(homedir(), '.pi', 'agent', 'spider');
    if (!isAbsolute(globalRoot)) throw new HerdrError('invalid-pane-root', 'Source root must be absolute');
    const config = parseHerdrConfig(JSON.parse(await readFile(join(globalRoot, 'herdr/config.json'), 'utf8')) as unknown);
    if (resolve(config.globalRoot) !== resolve(globalRoot)) throw new HerdrError('invalid-pane-root', 'Source config belongs to another root');
    const root = join(globalRoot, 'herdr'), presence = createProcessPresence(root), registry = createTerminalRegistry(root);
    const identity = () => observeCoreIdentity(config.core.binary, env, { timeoutMs: 5000 });
    return {
      async readHomeEpoch(sessionId) {
        const db = openDbReadOnly(join(globalRoot, 'spider.db')); if (!db) return 0;
        try {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_homes'").get()) return 0;
          const home = db.prepare('SELECT epoch FROM session_homes WHERE session_id=?').get(sessionId) as { epoch: number } | undefined;
          return home?.epoch ?? 0;
        } finally { db.close(); }
      },
      identity, listPresence: () => presence.list(), listMappings: () => registry.list(),
      async probe(pid) {
        try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { kind: 'absent' as const } : { kind: 'unknown' as const }; }
        const startIdentity = processStartTime(pid); return startIdentity ? { kind: 'live' as const, startIdentity } : { kind: 'unknown' as const };
      },
      async readFeed(sessionId) {
        paneId(sessionId);
        const raw = await readPrivateJson(join(root, 'sessions', sessionId, 'session.json'));
        if (raw === null) return null;
        const feed = parseFeed(JSON.stringify(raw));
        return feed && await sessionFeedIsFresh(root, feed, Date.now()) ? feed : null;
      },
      async readTerminal(owner) {
        const core = await identity();
        if (core.coreId !== owner.terminal.coreId || core.socket !== owner.terminal.socket || core.sessionNamespace !== owner.terminal.sessionNamespace) throw new HerdrError('core-mismatch', 'Source core identity changed');
        const address = `${paneId(core.coreId)}/${paneId(owner.terminal.terminalId)}`;
        return parsePaneTerminal(await invokeCli(config.core.binary, ['get', address, '--json'], env, PANE_REPLY_LIMIT, undefined, { timeoutMs: 5000 }));
      },
      // Unknown is different from an observed empty list.
      async readConsoles(owner) { return (await effects()).readConsoles(owner); }, clock: Date.now,
    } satisfies PaneSourceInventoryPorts;
  })();
  const resolveOwner: PaneEndpointPorts['resolveOwner'] = async (sessionId, generation) => {
    const p = await source(); let cursor: string | null = null;
    do {
      const page = await readPaneSourceInventory(cursor, { ...p, readConsoles: async () => [] });
      if (!page.complete) throw new HerdrError('pane-inventory-incomplete', 'Source inventory is incomplete');
      const match = page.rows.find(row => row.sessionId === sessionId && row.generation === generation && row.unavailableReason === null);
      if (match?.owner) return match.owner;
      cursor = page.next;
    } while (cursor !== null);
    throw new HerdrError('stale-pane-owner', 'Source owner is unavailable');
  };
  return {
    protocol: 1, buildDigest, resolveOwner,
    async dispose() { await ownedClient?.dispose(); },
    async listRows(cursor) { return readPaneSourceInventory(cursor, await source()); },
    locateFolder: async cwd => (await effects()).locateFolder(cwd),
    resolveFolder: async (...args) => (await effects()).resolveFolder(...args),
    launchViewer: async (...args) => (await effects()).launchViewer(...args),
    renewViewers: async leases => (await effects()).renewViewers(leases),
    stopViewer: async id => (await effects()).stopViewer(id),
    openConsole: async (...args) => (await effects()).openConsole(...args),
    closeSession: async (...args) => (await effects()).closeSession(...args),
  };
}

if ((import.meta as ImportMeta & { spiderPaneEndpointEntry?: boolean }).spiderPaneEndpointEntry !== false && process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  try {
    const bytes = await readFile(fileURLToPath(import.meta.url));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const output = await runPaneEndpointCli(process.argv.slice(2), async () => createProductionPaneEndpointPorts(digest));
    process.stdout.write(output + '\n');
  } catch (error) {
    const code = error instanceof HerdrError ? error.code : 'pane-endpoint-failed';
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  }
}
