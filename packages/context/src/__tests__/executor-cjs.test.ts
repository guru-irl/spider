import { describe, it, expect } from "vitest";
import { PolyglotExecutor } from "../executor";

// Regression: under a `"type":"module"` project (this repo), the exec script lives in
// <projectRoot>/.spider/scratch and Node treats a `.js` file there as ESM, where `require`
// is undefined. That broke both `require(...)` snippets and the executeFile FILE_CONTENT
// wrapper (which does `require("fs").readFileSync`). Scripts now run as CommonJS (`.cjs`).
describe("executor javascript CommonJS under type:module", () => {
  const haveNode = process.execPath.length > 0;

  it.runIf(haveNode)("exec: require() is available in a plain JS snippet", async () => {
    const exec = new PolyglotExecutor({ projectRoot: process.cwd() });
    const res = await exec.execute({
      language: "javascript",
      code: "const os = require('os'); console.log('ARCH=' + os.arch());",
      timeout: 20000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/ARCH=\w+/);
  });

  it.runIf(haveNode)("executeFile: the FILE_CONTENT wrapper (require) runs successfully", async () => {
    const exec = new PolyglotExecutor({ projectRoot: process.cwd() });
    const res = await exec.executeFile({
      path: "package.json",
      language: "javascript",
      code: "console.log('KEYS=' + Object.keys(JSON.parse(FILE_CONTENT)).length);",
    });
    expect(res.exitCode).toBe(0); // was 1 ("require is not defined") before the .cjs fix
    expect(res.stdout).toMatch(/KEYS=\d+/);
  });
});
