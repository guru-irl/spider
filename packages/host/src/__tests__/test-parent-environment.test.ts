import { expect, it } from "vitest";

it("starts every test file without inherited subagent identity", () => {
  for (const key of [
    "PI_SUBAGENT_CHILD", "PI_SPIDER_DB_PATH", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_SESSION_ID",
    "PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_CHILD_INDEX",
    "PI_SUBAGENT_FANOUT_CHILD", "PI_SUBAGENT_INTERCOM_SESSION_NAME",
  ]) {
    expect(process.env[key], key).toBeUndefined();
  }
});
