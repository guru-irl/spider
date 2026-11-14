import { expect, it } from "vitest";
import { InlineMessageComponent } from "./ui/inline-message.js";
import { SessionListOverlay } from "./ui/session-list.js";
import { resolveTargetInCwd } from "./project-agent.js";
import { resolveSessionTarget, qualifiedName, type RemoteSessionInfo, type LocalSessionInfo } from "./protocol.js";
const remote: RemoteSessionInfo = { remote: true, id: "peer", address: { sessionId: "peer", scopeId: null }, machineId: "machine-2", machineAlias: "box-1.invalid", homeEpoch: 1, activationEpoch: "activation", endpointEpoch: "activation", name: "helper", cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };
const local: LocalSessionInfo = { id: "local", name: "local", cwd: "/workspace", model: "fixture", pid: 1, startedAt: 1, lastActivity: 1 };
const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
it("incoming headers and peer lists show the remote machine", () => {
  const incoming = new InlineMessageComponent(remote, { id: "mail", timestamp: 1, content: { text: "synthetic" } }, theme as any).render(120).join("\n");
  expect(incoming).toContain("box-1.invalid/helper");
  const list = new SessionListOverlay(theme as any, { getKeys: () => [] } as any, local, [remote], () => undefined).render(120).join("\n");
  expect(list).toContain("box-1.invalid/helper");
  expect(list).not.toContain("same cwd");
}, 5000);
it("unqualified cwd-only targeting remains local", () => {
  expect(resolveTargetInCwd({ sessions: [local, remote], currentSessionId: "local", targetCwd: "/workspace" }).kind).toBe("missing");
}, 5000);
it("qualifier separators are encoded and duplicate names remain ambiguous", () => {
  const renamed = { ...remote, name: "helper/part", machineAlias: "box/part.invalid" };
  expect(qualifiedName(renamed)).toBe("box%2Fpart.invalid/helper%2Fpart");
  expect(resolveSessionTarget("box%2Fpart.invalid/helper%2Fpart", [renamed])).toEqual(renamed);
  expect(() => resolveSessionTarget("helper", [remote, { ...local, name: "helper" }])).toThrow(/ambiguous/);
}, 5000);
