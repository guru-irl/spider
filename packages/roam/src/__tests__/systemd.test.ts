import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { renderSupervisorUnit } from "../systemd";

it("renders only a private supervisor with the existing core dependencies", () => {
  const parent = dirname(scratchDbPath("roam-systemd"));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "unit-"));
  try {
    const coreFile = join(root, "herdr-core.service");
    writeFileSync(coreFile, "[Service]\nExecStart=/fixture/core\n", { mode: 0o600 });
    const coreUnitBefore = readFileSync(coreFile, "utf8");
    const unit = renderSupervisorUnit({ node: "/home/agent/bin/node", supervisor: "/home/agent/spider/supervisor.mjs", coreUnit: "herdr-core.service", globalRoot: "/home/agent/spider-data" });
    const lines = unit.split("\n");
    expect(lines).toContain("After=herdr-core.service");
    expect(lines).toContain("Requires=herdr-core.service");
    expect(lines).toContain("PartOf=herdr-core.service");
    expect(lines).toContain("Restart=on-failure");
    expect(lines).toContain("UMask=0077");
    expect(lines).toContain("WantedBy=default.target");
    expect(lines).toContain('ExecStart="/home/agent/bin/node" "/home/agent/spider/supervisor.mjs"');
    expect(lines).toContain('Environment="SPIDER_GLOBAL_ROOT=/home/agent/spider-data"');
    expect(readFileSync(coreFile, "utf8")).toBe(coreUnitBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 5000);

it("quotes paths without expanding systemd specifiers or environment references", () => {
  const unit = renderSupervisorUnit({ node: '/home/agent/a %n/$node', supervisor: '/home/agent/quote"slash\\run', coreUnit: "herdr-core.service", globalRoot: '/home/agent/data %h' });
  expect(unit.split("\n")).toContain('ExecStart="/home/agent/a %%n/$$node" "/home/agent/quote\\"slash\\\\run"');
  expect(unit.split("\n")).toContain('Environment="SPIDER_GLOBAL_ROOT=/home/agent/data %%h"');
}, 5000);

it("refuses relative paths and unit or line injection", () => {
  const safe = { node: "/home/agent/node", supervisor: "/home/agent/supervisor", coreUnit: "herdr-core.service", globalRoot: "/home/agent/data" };
  expect(() => renderSupervisorUnit({ ...safe, node: "node" })).toThrow();
  expect(() => renderSupervisorUnit({ ...safe, supervisor: "/home/agent/run\nExecStart=/bin/false" })).toThrow();
  expect(() => renderSupervisorUnit({ ...safe, globalRoot: "/home/agent/data\rEnvironment=BAD" })).toThrow();
  expect(() => renderSupervisorUnit({ ...safe, coreUnit: "herdr-core.service\nBefore=other.service" })).toThrow();
  expect(() => renderSupervisorUnit({ ...safe, coreUnit: "../other.service" })).toThrow();
}, 5000);
