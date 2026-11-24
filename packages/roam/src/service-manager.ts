import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";

export function launchctlBinary(): string {
  if (!process.env.SPIDER_TEST_FIXTURE_CHECKOUT) {
    if (process.platform !== "darwin") throw new Error("The hub service requires macOS");
    return "/bin/launchctl";
  }
  const file = process.env.SPIDER_TEST_ROAM_LAUNCHCTL;
  if (!file || !isAbsolute(file)) throw new Error("No isolated launchctl fixture");
  assertTestConfigPath(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe launchctl fixture");
  return file;
}
