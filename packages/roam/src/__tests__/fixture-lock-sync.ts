// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join, sep } from "node:path";
import type * as fs from "node:fs/promises";

/** These tests exercise lock-protected behavior, not lock survival after an OS crash. */
export function fixtureLockOpen(open: typeof fs.open, enabled: () => boolean): typeof fs.open {
  const roots = [join(process.cwd(), ".spider", "scratch"), join(process.cwd(), "packages", "db-core", ".spider", "scratch")];
  const wrapped = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const file = args[0];
    if (!enabled() || typeof file !== "string" || !roots.some(root => file.startsWith(root + sep)) || !file.includes(`${sep}locks${sep}`)) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "sync") return async () => {};
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return wrapped as typeof open;
}
