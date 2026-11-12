import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }): Promise<number> {
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) {
    io.out("Usage: spider-roam-supervisor [--help]\nHosting is unavailable in this build.\n");
    return 0;
  }
  if (argv.length > 0) {
    io.err("Invalid arguments. Run with --help for usage.\n");
    return 2;
  }
  io.err("Hosting is unavailable in this build.\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), { out: text => process.stdout.write(text), err: text => process.stderr.write(text) })
    .then(code => { process.exitCode = code; }, () => { process.stderr.write("Supervisor failed.\n"); process.exitCode = 1; });
}
