import { describe, expect, it } from "vitest";
import { defaultSpawner } from "../spawn-default";

describe("production spawner exit status", () => {
  it.skipIf(process.platform === "win32")("reports SIGTERM as nonzero instead of mapping code=null to success", async () => {
    const child = defaultSpawner({
      argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
      env: {}, cwd: process.cwd(), sessionFile: "unused",
    });
    const result = await child.wait();
    expect(result.exitCode).toBe(143);
  });
});
