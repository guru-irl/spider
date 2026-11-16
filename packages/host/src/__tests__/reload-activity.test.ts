import { expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trackReloadActivity } from "../reload-activity";
it("move blocks reload but excludes only itself from move preflight", async () => {
  const commands = new Map<string, { handler(...args: unknown[]): unknown }>();
  const activity = trackReloadActivity({ registerCommand(name: string, command: { handler(...args: unknown[]): unknown }) { commands.set(name, command); } } as unknown as ExtensionAPI);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  activity.pi.registerCommand("move", { handler: async () => { await pending; } });
  activity.pi.registerCommand("other", { handler: async () => { await pending; } });
  const moving = commands.get("move")!.handler("box", {});
  expect(activity.busy()).toBe(true); expect(activity.commandActive()).toBe(true); expect(activity.ordinaryCommandActive!()).toBe(false);
  const other = commands.get("other")!.handler("", {});
  expect(activity.ordinaryCommandActive!()).toBe(true);
  release(); await Promise.all([moving, other]);
  expect(activity.busy()).toBe(false); expect(activity.ordinaryCommandActive!()).toBe(false);
});
it("failed move handlers release activity without suppressing later commands", async () => {
  let handler!: (...args: unknown[]) => unknown;
  const activity = trackReloadActivity({ registerCommand(_name: string, command: { handler(...args: unknown[]): unknown }) { handler = command.handler; } } as unknown as ExtensionAPI);
  activity.pi.registerCommand("move", { async handler() { throw new Error("fixture-failure"); } });
  await expect(handler("box", {})).rejects.toThrow("fixture-failure");
  expect(activity.busy()).toBe(false); expect(activity.commandActive()).toBe(false); expect(activity.ordinaryCommandActive!()).toBe(false);
});
