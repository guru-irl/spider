import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { startProductionSupervisor } from "./production-supervisor";
import { pathToFileURL } from "node:url";
import { RUNNING_INTENT_SOURCE_UNAVAILABLE } from "./supervisor";

export async function main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }): Promise<number> {
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) {
    io.out("Usage: spider-roam-supervisor [--help]\nHosts sessions only for an enrolled box with initialized capture and hub-issued intent.\n");
    return 0;
  }
  if (argv.length > 0) {
    io.err("Invalid arguments. Run with --help for usage.\n");
    return 2;
  }
  try {
    const root = process.env.SPIDER_GLOBAL_ROOT || join(homedir(), ".pi", "agent", "spider");
    const service = await startProductionSupervisor(root);
    try { await new Promise<void>(done => {
      const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); done(); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    }); } finally { await service.stop(); }
    return 0;
  } catch {
    io.err(`Hosting is unavailable (${RUNNING_INTENT_SOURCE_UNAVAILABLE}). Run spider roam doctor.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), { out: text => process.stdout.write(text), err: text => process.stderr.write(text) })
    .then(code => { process.exitCode = code; }, () => { process.stderr.write("Supervisor failed.\n"); process.exitCode = 1; });
}
