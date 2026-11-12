import { expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { MachineId } from "@spider/db-core/roam/types";
import { openJournal } from "../journal.js";

const fault = vi.hoisted(() => ({ busy: false }));
vi.mock("@spider/db-core", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/db-core")>();
  return {
    ...actual,
    openDb(...args: Parameters<typeof actual.openDb>) {
      if (fault.busy) {
        fault.busy = false;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return actual.openDb(...args);
    },
  };
});

it("opens and reserves an operation after a transient SQLite startup lock", () => {
  const root = join(dirname(scratchDbPath("roam-contention")), `operation-contention-${crypto.randomUUID()}`);
  try {
    fault.busy = true;
    const journal = openJournal(join(root, "journal.db"));
    expect(journal.begin({ id: "operation-1", machineId: "00000000-0000-4000-8000-000000000001" as MachineId, expectedEpoch: null, kind: "sync", args: {} }))
      .toEqual({ kind: "new", result: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 5000);
