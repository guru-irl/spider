// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { resolve } from "node:path";
import type { MovePorts } from "./contracts";

export interface PowerProcess { exited: Promise<void>; stop(): Promise<void> }
export interface PowerPorts {
  pid: number;
  spawn(argv: readonly string[]): Promise<PowerProcess>;
  onExit(listener: () => void): () => void;
  notice(message: string): void;
}

/** Production supplies the process adapter; constructing this factory performs no OS calls. */
export function createMovePower(ports: PowerPorts): MovePorts["power"] {
  return async () => {
    if (!Number.isSafeInteger(ports.pid) || ports.pid < 1) throw new Error("move-power-pid-invalid");
    const child = await ports.spawn(["caffeinate", "-i", "-w", String(ports.pid)]);
    let released = false;
    let releasing: Promise<void> | null = null;
    let unsubscribe: () => void = () => {};
    const release = (): Promise<void> => {
      if (released) return Promise.resolve();
      if (releasing) return releasing;
      releasing = (async () => {
        await child.stop();
        await child.exited;
        released = true;
        unsubscribe();
      })().finally(() => { releasing = null; });
      return releasing;
    };
    try {
      unsubscribe = ports.onExit(() => { void release().catch(() => {}); });
      ports.notice("Keep the Mac awake until the move finishes.");
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  };
}

const assertions = new Map<string, Promise<() => Promise<void>>>();
export function movePowerKey(ports: Pick<MovePorts, "globalDb">, moveId: string): string {
  return JSON.stringify([resolve(ports.globalDb.raw.name), moveId]);
}
/** A pending move retains its handle. After process restart recovery reacquires it. */
export async function acquireMovePower(key: string, acquire: MovePorts["power"]): Promise<void> {
  let held = assertions.get(key);
  if (!held) {
    held = acquire();
    assertions.set(key, held);
    void held.catch(() => { if (assertions.get(key) === held) assertions.delete(key); });
  }
  await held;
}
export async function releaseMovePower(key: string): Promise<void> {
  const held = assertions.get(key);
  if (!held) return;
  await (await held)();
  if (assertions.get(key) === held) assertions.delete(key);
}
