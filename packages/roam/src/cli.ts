import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `Usage: spider <command>

  spider roam status [--json]
  spider roam sync [machine]
  spider roam enable|disable
  spider roam doctor [machine]
  spider roam provision <machine>
  spider roam repo map <repo-key> <path>
  spider roam memory tag <store-key> <uuid> <machine|all>
  spider move <session> <machine>

Roaming operations are unavailable until their services are installed.
`;

function positional(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0 && !value.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(value);
}
function valid(args: readonly string[]): boolean {
  if (args[0] === "move") return args.length === 3 && positional(args[1]) && positional(args[2]);
  if (args[0] !== "roam") return false;
  switch (args[1]) {
    case "status": return args.length === 2 || args.length === 3 && args[2] === "--json";
    case "enable": case "disable": return args.length === 2;
    case "sync": case "doctor": return args.length === 2 || args.length === 3 && positional(args[2]);
    case "provision": case "recover": case "cancel": case "forget": case "claim": case "stop": case "resume":
      return args.length === (args[1] === "claim" ? 4 : 3) && args.slice(2).every(positional);
    case "repo": return args[2] === "map" && args.length === 5 && args.slice(3).every(positional);
    case "memory": return args[2] === "tag" && args.length === 6 && args.slice(3).every(positional);
    default: return false;
  }
}

/** Parse before loading configuration, a database, or a transport. */
export async function main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }): Promise<number> {
  if (argv.length === 0 || argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]) ||
      argv.length === 2 && argv[0] === "roam" && ["--help", "-h", "help"].includes(argv[1])) {
    io.out(HELP);
    return 0;
  }
  if (!valid(argv)) {
    io.err("Invalid arguments. Run spider --help for usage.\n");
    return 2;
  }
  io.err("This roaming command is unavailable in this build.\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), { out: text => process.stdout.write(text), err: text => process.stderr.write(text) })
    .then(code => { process.exitCode = code; }, () => { process.stderr.write("Roaming command failed.\n"); process.exitCode = 1; });
}
