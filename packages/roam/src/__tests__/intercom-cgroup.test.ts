import { expect, it } from "vitest";
import { pairCgroupProcesses } from "../intercom-pair-resources";
it("a straggler in a descendant cgroup prevents an empty-group proof", () => {
  const rows = new Map([["/pair.service", { procs: "", children: ["child"] }], ["/pair.service/child", { procs: "124\n", children: [] }]]);
  expect(pairCgroupProcesses("/pair.service", { present: path => rows.has(path), processes: path => rows.get(path)!.procs, directories: path => rows.get(path)!.children })).toEqual([124]);
}, 5000);
it("a missing cgroup is empty but a failed or malformed read provides no proof", () => {
  expect(pairCgroupProcesses("/pair.service", { present: () => false, processes: () => { throw new Error("unexpected read"); }, directories: () => [] })).toEqual([]);
  expect(() => pairCgroupProcesses("/pair.service", { present: () => true, processes: () => { throw new Error("unreadable"); }, directories: () => [] })).toThrow("unreadable");
  for (const procs of ["0", "bad", "9007199254740992"]) expect(() => pairCgroupProcesses("/pair.service", { present: () => true, processes: () => procs, directories: () => [] })).toThrow("intercom-cgroup-unavailable");
}, 5000);
it("refuses an unsafe or unbounded descendant inventory", () => {
  for (const children of [[".."], ["/other"], ["bad/name"]]) expect(() => pairCgroupProcesses("/pair.service", { present: () => true, processes: () => "", directories: () => children })).toThrow("intercom-cgroup-unavailable");
  expect(() => pairCgroupProcesses("/pair.service", { present: () => true, processes: () => "", directories: () => ["child"] })).toThrow("intercom-cgroup-unavailable");
}, 5000);
