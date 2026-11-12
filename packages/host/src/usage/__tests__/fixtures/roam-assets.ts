import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createFixtureRoam(checkout: string): void {
  const directory = join(checkout, "dist/roam");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of ["cli.mjs", "supervisor.mjs"]) {
    writeFileSync(join(directory, entry), "#!/usr/bin/env node\nexport {};\n", { mode: 0o700 });
  }
}
