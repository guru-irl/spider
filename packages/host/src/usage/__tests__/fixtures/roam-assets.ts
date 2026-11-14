import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createFixtureRoam(checkout: string): void {
  const directory = join(checkout, "dist/roam");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of ["cli-main.mjs", "intercom-helper.mjs", "supervisor.mjs"]) {
    writeFileSync(join(directory, entry), "#!/usr/bin/env node\nexport {};\n", { mode: 0o700 });
  }
  writeFileSync(join(directory, "cli.mjs"), '#!/usr/bin/env node\nif (process.argv.includes("--intercom-exchange")) await import("./intercom-helper.mjs"); else await import("./cli-main.mjs");\n', { mode: 0o700 });
}
