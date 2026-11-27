import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:module");
  vi.resetModules();
});

it("strips the provisioning payload only on first use", async () => {
  vi.resetModules();
  const actual = await import("node:module");
  const strip = vi.fn(actual.stripTypeScriptTypes);
  vi.doMock("node:module", () => ({ ...actual, stripTypeScriptTypes: strip }));

  const provision = await import("../provision-remote-script");
  expect(strip).not.toHaveBeenCalled();

  const getScript = (provision as unknown as { getProvisionRemoteScript(): string }).getProvisionRemoteScript;
  const first = getScript();
  const second = getScript();
  expect(strip).toHaveBeenCalledTimes(1);
  expect(second).toBe(first);
  expect(first).toContain('await import("data:text/javascript;base64,"');
});
