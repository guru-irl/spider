import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import roamEntries from "../../../../../../scripts/roam-entries.json" with { type: "json" };

export function createFixtureRoam(checkout: string): void {
  const directory = join(checkout, "dist/roam");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const mode of Object.keys(roamEntries)) {
    if (mode === "cli") continue;
    writeFileSync(join(directory, `${mode}.mjs`), "#!/usr/bin/env node\nexport {};\n", { mode: 0o700 });
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
