// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isDeepStrictEqual } from 'node:util';
import { HerdrError } from '../client/parse.js';

const missing = Symbol('missing');
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Value = Json | typeof missing;
const record = (value: Value): value is Record<string, Json> => value !== missing && value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: Json): string | undefined => {
  if (!record(value)) return undefined;
  if (typeof value.id === 'string') return value.id;
  return undefined;
};

/** A three-way reverse patch: only differences introduced by setup are owned. */
export function restoreLayout(current: Buffer | null, baseline: Buffer | null, installed: Buffer | null, path: string, replace: boolean): Buffer | null {
  const changed = (part: string): never => { throw new HerdrError('upgrade-checkpoint-changed', `Layout part changed after setup: ${path}#${part}. Inspect this part, then retry rollback --undo-upgrade --replace-changed; unrelated layout entries are preserved.`); };
  const ambiguous = (part: string): never => { throw new HerdrError('upgrade-layout-ambiguous', `Layout part cannot be merged unambiguously: ${path}#${part}. Move this customized layout to a .kept file, then retry rollback --undo-upgrade --replace-changed. The saved layout keeps every custom entry for reconciliation.`); };
  const reverse = (now: Value, before: Value, after: Value, part: string): Value => {
    if (isDeepStrictEqual(before, after)) return now;
    if (part === '/generation' || part === '/release') return before;
    if (isDeepStrictEqual(now, after) || isDeepStrictEqual(now, before)) return before;
    if (record(now) && (record(before) || before === missing) && (record(after) || after === missing)) {
      const old = before === missing ? {} : before, next = after === missing ? {} : after;
      const result = { ...now };
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        const value = reverse(Object.hasOwn(now, key) ? now[key] : missing, Object.hasOwn(old, key) ? old[key] : missing, Object.hasOwn(next, key) ? next[key] : missing, `${part}/${key}`);
        if (value === missing) delete result[key];
        else Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      }
      return before === missing && !Object.keys(result).length ? missing : result;
    }
    if (Array.isArray(now) && (Array.isArray(before) || before === missing) && (Array.isArray(after) || after === missing)) {
      const oldArray = before === missing ? [] : before, nextArray = after === missing ? [] : after;
      const finish = (items: Json[]): Value => before === missing && !items.length ? missing : items;
      const keyed = (array: Json[]) => array.every(value => identity(value) !== undefined) && new Set(array.map(identity)).size === array.length;
      if (keyed(oldArray) && keyed(nextArray) && keyed(now)) {
        const old = new Map(oldArray.map(value => [identity(value)!, value])), next = new Map(nextArray.map(value => [identity(value)!, value]));
        const result: Json[] = [];
        for (const node of now) {
          const id = identity(node)!;
          // Entire nodes added by setup belong to setup, even after a resize.
          if (!old.has(id) && next.has(id)) continue;
          const value = reverse(node, old.get(id) ?? missing, next.get(id) ?? missing, `${part}/${id}`);
          if (value !== missing) result.push(value);
        }
        for (let index = 0; index < oldArray.length; index++) {
          const node = oldArray[index]!, id = identity(node)!;
          if (next.has(id) || result.some(value => identity(value) === id)) continue;
          const following = oldArray.slice(index + 1).map(identity), position = result.findIndex(value => following.includes(identity(value)));
          result.splice(position < 0 ? result.length : position, 0, node);
        }
        return finish(result);
      }
      // An appended unrelated node does not become setup-owned.
      if ((nextArray.length || !oldArray.length) && now.length >= nextArray.length && nextArray.every((value, index) => isDeepStrictEqual(value, now[index]))) return finish([...oldArray, ...now.slice(nextArray.length)]);
      return ambiguous(part);
    }
    if (record(now) || Array.isArray(now)) return ambiguous(part);
    if (!replace) return changed(part);
    return before;
  };
  try {
    const parse = (bytes: Buffer | null): Value => bytes === null ? missing : JSON.parse(bytes.toString('utf8')) as Json;
    const original = parse(baseline), result = reverse(parse(current), original, parse(installed), '');
    if (isDeepStrictEqual(result, original)) return baseline;
    return result === missing ? null : Buffer.from(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    if (error instanceof SyntaxError) throw new HerdrError('upgrade-checkpoint-changed', `Invalid layout JSON: ${path}. Repair its JSON syntax while preserving custom entries, then retry rollback --undo-upgrade.`);
    throw error;
  }
}
