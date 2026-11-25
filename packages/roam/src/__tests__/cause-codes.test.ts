import { expect, it } from "vitest";
import { moveOperationStep, safeCauseCode, safeMoveFailureStep } from "../cause-codes";

it("allows the explicit unavailable launch status through cause-code boundaries", () => {
  expect(safeCauseCode("exit-status-unavailable")).toBe("exit-status-unavailable");
  expect(safeCauseCode("exit-status-unavailable\nprivate")).toBeUndefined();
});

it.each([
  ["move-workspace-map", "workspace-plan"], ["session-inspect", "source-inspect"], ["move-diagnostics", "destination-diagnostics"],
  ["move-seed", "seed"], ["move-prerequisites", "remote-prepare"], ["session-freeze", "freeze"],
  ["move-export", "transfer"], ["move-import", "transfer"], ["move-verify", "verify-source"], ["session-start", "start"],
  ["move-observation", "destination-inspect"], ["session-retire", "source-retire"], ["move-cleanup", "cleanup"],
  ["move-intercom-inspect", "intercom-inspect"], ["move-intercom-checkGeneration", "generation-check"], ["move-intercom-ready", "intercom-ready"],
  ["move-location", "preflight"],
])("names the %s participant adapter as %s", (operation, step) => {
  expect(moveOperationStep(operation)).toBe(step);
  expect(safeMoveFailureStep(step)).toBe(step);
});

it.each(["preflight", "power", "seed-barriers", "initial-home", "source-home-replicate", "final-barriers", "home-commit",
  "home-replicate", "same-home-inspect", "destination-endpoint", "final-inspect", "power-release"])("accepts the move journal step %s", step => {
  expect(safeMoveFailureStep(step)).toBe(step);
});

it.each(["untrusted-step", "/fixture/private-file", "freeze\nprivate", "", null, 3])("rejects an unregistered move step %j", step => {
  expect(safeMoveFailureStep(step)).toBeUndefined();
});
