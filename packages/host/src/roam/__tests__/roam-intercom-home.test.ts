import { expect, it, vi } from "vitest";
import * as core from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { createHostIntercomPorts } from "../intercom";

it("an empty-machine conflict marker is not an assigned intercom home", () => {
  const replica = createReplica("global", "00000000-0000-4000-8000-000000000001");
  const close = replica.db.close.bind(replica.db);
  const closeSpy = vi.spyOn(replica.db, "close").mockImplementation(() => {});
  const open = vi.spyOn(core, "openGlobalReadOnly").mockReturnValue(replica.db);
  try {
    replica.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at) VALUES (?,'',1,1)").run("conflicted");
    const ports = createHostIntercomPorts({ inspect: () => ({ kind: "ordinary", home: null, blockers: [] }) } as any);
    expect(ports.home({ sessionId: "conflicted", scopeId: null })).toBeNull();
  } finally { open.mockRestore(); closeSpy.mockRestore(); close(); replica.close(); }
}, 5000);
