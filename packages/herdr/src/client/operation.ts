// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { AsyncLocalStorage } from 'node:async_hooks';
const operations = new AsyncLocalStorage<{ active: boolean; observations: Map<unknown, Promise<unknown>> }>();
/** Nested source and display steps share the operation, never a timed cache. */
export function withHcOperation<T>(effect: () => Promise<T>): Promise<T> {
  if (operations.getStore()?.active) return effect();
  const operation = { active: true, observations: new Map<unknown, Promise<unknown>>() };
  return operations.run(operation, async () => {
    try { return await effect(); }
    finally { operation.active = false; operation.observations.clear(); }
  });
}
export function operationObservation<T>(key: unknown, read: () => Promise<T>): Promise<T> {
  const operation = operations.getStore();
  if (!operation?.active) return read();
  const { observations } = operation;
  const previous = observations.get(key);
  if (previous) return previous as Promise<T>;
  const value = read(); observations.set(key, value); return value;
}
