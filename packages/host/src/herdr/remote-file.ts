// SPDX-License-Identifier: MIT
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HcClient, HerdrConfig, MachineName, RemoteSource, RuntimeTarget, PreparedProgram } from '@spider/herdr';
import { HerdrError } from '@spider/herdr/client/parse';
import { probeLaunch } from '@spider/herdr/setup/doctor';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { resolveMachine } from './machine.js';

const HOME_CACHE = Symbol.for('spider.herdr.remote-home.v1');
interface SessionHomes { id: string; homes: Map<MachineName, Promise<string>> }
const hostGlobal = globalThis as typeof globalThis & { [HOME_CACHE]?: WeakMap<object, SessionHomes> };
const sessionHomes = hostGlobal[HOME_CACHE] ??= new WeakMap<object, SessionHomes>();

export interface RemoteFileResolver {
  resolve(file: string, on: MachineName): Promise<string>;
  read(file: string, on: MachineName): Promise<string>;
  prepare(source: RemoteSource, target: RuntimeTarget): Promise<PreparedProgram>;
}
export function createRemoteFileResolver(hc: HcClient, machines: HerdrConfig['machines'], session: { manager: object; id: string }): RemoteFileResolver {
  let cached = sessionHomes.get(session.manager);
  if (!cached || cached.id !== session.id) { cached = { id: session.id, homes: new Map() }; sessionHomes.set(session.manager, cached); }
  const homes = cached.homes;
  const probeHome = async (machine: HerdrConfig['machines'][number], on: MachineName): Promise<string> => {
    const launch = probeLaunch({ machine: on, nodePath: machine.nodePath ?? 'node', coreStartedAt: '' });
    const terminal = await hc.run({ ...launch, argv: [machine.nodePath ?? 'node', '-e', 'process.stdout.write(JSON.stringify(require("node:os").homedir()))'] });
    let failed = false;
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const state = await hc.get(terminal.address);
        if (state.state === 'finished') {
          const output = (await hc.read(terminal.address, { lines: 100 })).trim();
          if (state.exitCode !== 0) throw new HerdrError('remote-home-probe-failed', `Remote home probe on ${machine.name} exited with ${state.exitCode ?? state.signal}: ${output}`);
          let home: unknown;
          try { home = JSON.parse(output); }
          catch { throw new HerdrError('remote-home-invalid', `Remote home probe on ${machine.name} returned invalid JSON: ${output}`); }
          if (typeof home !== 'string' || !posix.isAbsolute(home) || home.includes('\0')) throw new HerdrError('remote-home-invalid', `Remote home probe on ${machine.name} did not return an absolute path`);
          return home;
        }
        await delay(25);
      }
      throw new HerdrError('remote-home-probe-timeout', `Remote home probe on ${machine.name} did not finish within 10000 ms`);
    } catch (error) { failed = true; throw error; }
    finally {
      let cleanupError: unknown;
      for (const cleanup of [() => hc.kill(terminal.address), () => hc.rm(terminal.address)]) {
        try { await cleanup(); }
        catch (error) { if (!(error instanceof HerdrError && ['not_found', 'core-unavailable', 'disposed'].includes(error.code))) cleanupError ??= error; }
      }
      if (!failed && cleanupError) throw cleanupError;
    }
  };
  const resolveFor = async (file: string, machine: HerdrConfig['machines'][number], on: MachineName): Promise<string> => {
    if (posix.isAbsolute(file)) return file;
    let base = machine.runtime.cwd;
    if (base === null) {
      let pending = homes.get(on);
      if (!pending) {
        pending = probeHome(machine, on); homes.set(on, pending);
        const probe = pending;
        void probe.catch(() => { if (homes.get(on) === probe) homes.delete(on); });
      }
      base = await pending;
    }
    return posix.resolve(base, file);
  };
  const resolve = async (file: string, on: MachineName): Promise<string> => {
    const selected = await resolveMachine(hc, machines, on);
    return resolveFor(file, selected.machine, selected.on);
  };
  return {
    resolve,
    read: async (file: string, on: MachineName) => {
      const selected = await resolveMachine(hc, machines, on);
      return (await hc.fileRead(selected.on, await resolveFor(file, selected.machine, selected.on))).toString();
    },
    prepare: async (source: RemoteSource, target: RuntimeTarget) => prepareRemoteProgram(source.kind === 'file' ? { ...source, path: await resolve(source.path, target.on) } : source, target),
  };
}
