import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { lstat, realpath } from 'node:fs/promises';
import { assertTestConfigPath } from '@spider/db-core';
import { join, resolve } from "node:path";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createSessionLeases, type ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import { processStartTime } from "../../../subagents/src/process-identity";
import { fixtureProcessDomain } from "./fixture-process-domain";
export function isPiProcessRow(platform: NodeJS.Platform, row: { title: string; executable: string; args: string }): boolean {
  const title = row.title.split(/[/\\]/).pop()!;
  const executable = (platform === 'linux' ? row.executable || row.args.trim().split(/\s+/, 1)[0] : row.executable).split(/[/\\]/).pop()!;
  const pi = /^(?:pi|pi-coding-agent)(?:\.exe)?$/.test(title);
  const nodeEntry = /^(?:node|nodejs)(?:\.exe)?$/.test(executable) && /^\S+\s+\S*[/\\]pi-coding-agent[/\\]dist[/\\](?:bundle[/\\])?cli\.m?js(?:\s|$)/.test(row.args);
  return pi || nodeEntry;
}

export function createProcessInventory(root: string, readOnly = false, additionalRoots: readonly string[] = []): ProcessInventoryPorts {
  const storedPresence = createProcessPresence(root);
  const leases = createSessionLeases(root), domain = fixtureProcessDomain(root);
  const otherRoots = domain ? [] : [...new Set(additionalRoots.map(path => resolve(path)))].filter(path => path !== resolve(root));
  const presence: ProcessInventoryPorts['presence'] = {
    record: storedPresence.record,
    // Foreign registrations are evidence, never ours to prune or replace.
    remove: readOnly ? async () => {} : storedPresence.remove,
    async list() {
      const records = await storedPresence.list();
      for (const other of otherRoots) {
        assertTestConfigPath(other);
        try {
          const info = await lstat(other);
          if (!info.isDirectory() || info.isSymbolicLink() || await realpath(other) !== other ||
              process.getuid && info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('unsafe-process-presence-root');
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const foreign = await createProcessPresence(other).list();
        records.push(...foreign.filter(record => record.sessionId !== null && record.sessionFile !== null));
      }
      return records;
    },
  };
  const probe: ProcessInventoryPorts['probe'] = async pid => {
    try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { kind: 'absent' } : { kind: 'unknown' }; }
    const startIdentity = processStartTime(pid);
    return startIdentity ? { kind: 'live', startIdentity } : { kind: 'unknown' };
  };
  return { presence, leases, probe, async processes() {
    if (domain) return domain.processes();
    // Same-user inventory remains read-only. An unreadable process is blocking, not absent.
    // Keep the mutable process title and the untruncated executable name on macOS.
    const rows = execFileSync('ps', ['-U', String(process.getuid?.() ?? 0), '-o', process.platform === 'darwin' ? 'pid=,comm=,ucomm=,args=' : 'pid=,comm=,comm=,args='], { encoding: 'utf8' }).split('\n');
    return rows.flatMap(line => {
      const match = /^\s*(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line); if (!match) return [];
      const pid = Number(match[1]);
      let executable = match[3];
      if (process.platform === 'linux') {
        try { executable = readlinkSync(`/proc/${pid}/exe`); } catch { executable = ''; }
      }
      if (!isPiProcessRow(process.platform, { title: match[2], executable, args: match[4] ?? '' })) return [];
      return [{ pid, startIdentity: processStartTime(pid), classification: 'pi' as const }];
    });
  } };
}
