// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export type NativeRunCall = { name: string; args: Record<string, unknown> } & (
  { state: 'pending'; result?: never; error?: never } |
  { state: 'succeeded'; result: unknown; error?: never } |
  { state: 'failed'; result?: never; error: { name: string; message: string; code?: string } }
);
export function createNativeRun(command: (name: string, args: Record<string, unknown>) => Promise<unknown>, onSettled: () => Promise<void> = async () => {}) {
  const calls: NativeRunCall[] = [], pending = new Set<Promise<void>>(), refreshErrors: unknown[] = [];
  return {
    calls: calls as readonly NativeRunCall[],
    // Native herdr.d.ts: run(name, args?) returns null, not a Promise.
    run(name: string, args: Record<string, unknown> = {}): null {
      const index = calls.push({ name, args, state: 'pending' }) - 1;
      const task = (async () => {
        try { const result = await command(name, args); calls[index] = { name, args, state: 'succeeded', result }; }
        catch (error) {
          const detail = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown; code?: unknown } : { message: String(error) };
          calls[index] = { name, args, state: 'failed', error: { name: typeof detail.name === 'string' ? detail.name : 'Error', message: typeof detail.message === 'string' ? detail.message : String(error), ...(typeof detail.code === 'string' ? { code: detail.code } : {}) } };
        }
        await onSettled();
      })();
      pending.add(task);
      void task.then(() => { pending.delete(task); }, error => { pending.delete(task); refreshErrors.push(error); });
      return null;
    },
    async flush(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
      if (refreshErrors.length) throw refreshErrors[0];
    },
  };
}
