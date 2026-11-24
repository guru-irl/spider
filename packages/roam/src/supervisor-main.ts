import { join } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { startProductionSupervisor } from "./production-supervisor";
import { fileURLToPath } from "node:url";
import { RUNNING_INTENT_SOURCE_UNAVAILABLE } from "./supervisor";

export { startProductionSupervisor };

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
    let unbind = () => {};
    try {
      const signal = new Promise<undefined>(done => {
        const stop = () => done(undefined);
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        unbind = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); };
      });
      const reason = await Promise.race([signal, service.failed]);
      if (reason) throw Object.assign(new Error(reason), { code: reason });
    } finally { unbind(); await service.stop(); }
    return 0;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const reason = typeof code === "string" && ["core-changed", "core-lost", "core-unavailable", "core-pin-required", "core-pin-invalid", "core-pin-conflict", "core-pin-changed", "core-pin-busy", "missing-hc"].includes(code) ? code : RUNNING_INTENT_SOURCE_UNAVAILABLE;
    io.err(`Hosting is unavailable (${reason}). Run spider roam doctor.\n`);
    return 1;
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  main(process.argv.slice(2), { out: text => process.stdout.write(text), err: text => process.stderr.write(text) })
    .then(code => { process.exitCode = code; }, () => { process.stderr.write("Supervisor failed.\n"); process.exitCode = 1; });
}
