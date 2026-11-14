import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createFixtureRoam(checkout: string): void {
  const directory = join(checkout, "dist/roam");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of ["cli-main.mjs", "intercom-helper.mjs", "supervisor.mjs"]) {
    writeFileSync(join(directory, entry), "#!/usr/bin/env node\nexport {};\n", { mode: 0o700 });
  }
  writeFileSync(join(directory, "cli.mjs"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 5 && args[0] === "--global-root" && args[2] === "roam" && args[3] === "intercom" && (args[4] === "exchange" || args[4] === "revoke-local")) {
  await import("./intercom-helper.mjs");
} else {
  await import("./cli-main.mjs");
}
`, { mode: 0o700 });
}
