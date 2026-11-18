import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSupervisorCorePin } from "../enrollment";

export function enrollFixtureCore(root: string, coreId = "fixture-core") {
  const pin = { binary: join(root, "hc"), coreId, socket: join(root, "core.sock"), sessionNamespace: "fixture",
    stateHome: join(root, "state"), configHome: join(root, "config") };
  writeFileSync(pin.binary, `#!${process.execPath}
const command = process.argv.slice(2).join(' ');
if (command !== 'server start --json' && command !== 'server status --json') process.exit(1);
console.log(JSON.stringify({version:'0.1.16',core:{id:${JSON.stringify(coreId)}},pid:4321}));
`, { mode: 0o700 });
  installSupervisorCorePin(root, pin);
  return pin;
}
