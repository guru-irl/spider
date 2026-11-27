import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:module");
  vi.restoreAllMocks();
  vi.resetModules();
});

it("imports without type stripping support and reports it on provisioning", async () => {
  vi.resetModules();
  const actual = await import("node:module");
  const getBuiltin = process.getBuiltinModule.bind(process);
  const withoutStrip = { ...actual, stripTypeScriptTypes: undefined };
  vi.doMock("node:module", () => withoutStrip);
  vi.spyOn(process, "getBuiltinModule").mockImplementation(
    ((id: string) => id === "node:module" ? withoutStrip : getBuiltin(id)) as typeof process.getBuiltinModule,
  );

  const provision = await import("../provision-remote-script");
  expect(() => provision.getProvisionRemoteScript()).toThrowError(
    expect.objectContaining({
      name: "UnsupportedProvisioningNodeError",
      code: "node-type-stripping-unavailable",
      message: expect.stringMatching(/stripTypeScriptTypes.*provisioning.*Node/i),
    }),
  );
});

it("strips the provisioning payload only on first use", async () => {
  vi.resetModules();
  const actual = await import("node:module");
  const getBuiltin = process.getBuiltinModule.bind(process);
  const strip = vi.fn(actual.stripTypeScriptTypes);
  const withSpy = { ...actual, stripTypeScriptTypes: strip };
  vi.doMock("node:module", () => withSpy);
  vi.spyOn(process, "getBuiltinModule").mockImplementation(
    ((id: string) => id === "node:module" ? withSpy : getBuiltin(id)) as typeof process.getBuiltinModule,
  );

  const provision = await import("../provision-remote-script");
  expect(strip).not.toHaveBeenCalled();

  const getScript = (provision as unknown as { getProvisionRemoteScript(): string }).getProvisionRemoteScript;
  const first = getScript();
  const second = getScript();
  expect(strip).toHaveBeenCalledTimes(1);
  expect(second).toBe(first);
  expect(first).toContain('await import("data:text/javascript;base64,"');
});
