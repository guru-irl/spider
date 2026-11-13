import { homedir } from "node:os";
import { join } from "node:path";
import { runLocalDoctor, runLocalStatus } from "./local-diagnostics";

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

function clean(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, "?"); }
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
export async function main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }, options?: { bundleUrl?: URL }): Promise<number> {
  if (argv.length === 0 || argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]) ||
      argv.length === 2 && argv[0] === "roam" && ["--help", "-h", "help"].includes(argv[1])) {
    io.out(HELP);
    return 0;
  }
  if (!valid(argv)) {
    io.err("Invalid arguments. Run spider --help for usage.\n");
    return 2;
  }
  if (argv[0] === "roam" && argv[1] === "status") {
    const root = process.env.SPIDER_GLOBAL_ROOT || join(homedir(), ".pi", "agent", "spider");
    try {
      const status = runLocalStatus({ root });
      if (argv[2] === "--json") io.out(`${JSON.stringify(status)}\n`);
      else {
        const number = (value: number | null) => value === null ? "unknown" : String(value);
        const timestamp = (value: number | null) => value === null ? "unknown" : new Date(value).toISOString();
        io.out(`Roaming is ${status.enabled ? "enabled" : "disabled"}. Status is cached${status.complete ? "" : " and incomplete or unavailable"}.\n`);
        for (const home of status.homes) io.out(`Home ${clean(home.sessionId)}: ${clean(home.machineId)} (epoch ${home.epoch}).\n`);
        for (const session of status.homeConflicts) io.out(`Home conflict: ${clean(session)}.\n`);
        for (const peer of status.peers) io.out(`Peer ${clean(peer.alias)}: ${peer.connected === null ? "connection unknown" : peer.connected ? "connected" : "disconnected"}; last sync ${timestamp(peer.lastSyncAt)}; observation age ${number(peer.observationAgeMs)} ms; backlog ${number(peer.backlog)}.\n`);
        for (const store of status.stores) {
          io.out(`Store ${clean(store.key)}: head ${store.head}, ${store.changes} changes, log ${number(store.logBytes)} bytes, versions ${number(store.versionBytes)} bytes, ${store.tombstones} tombstones.\n`);
          for (const cursor of store.cursors) io.out(`  Cursor ${clean(cursor.machineId)} / ${clean(cursor.stream)}: ${cursor.through}.\n`);
        }
        for (const warning of status.warnings) io.out(`Warning ${clean(warning.machineId)}: ${clean(warning.kind)}.\n`);
        for (const item of status.suspensions) io.out(`Suspended ${clean(item.sessionId)} on ${clean(item.machineId)} (epoch ${item.epoch}).\n`);
        if (status.incompleteOperations === null) io.out("Incomplete operations: unknown.\n");
        else for (const operation of status.incompleteOperations) io.out(`Incomplete ${clean(operation.kind)}: ${clean(operation.id)} on ${clean(operation.machineId)}.\n`);
        for (const diagnostic of status.diagnostics) io.out(`${clean(diagnostic.reason)}\n`);
      }
      return 0;
    } catch {
      io.err("Cannot inspect local roaming status. No data was changed.\n");
      return 1;
    }
  }
  if (argv[0] === "roam" && argv[1] === "doctor") {
    if (argv.length !== 2) {
      io.err("Remote doctor is unavailable in this build. Run spider roam doctor on that machine.\n");
      return 1;
    }
    const root = process.env.SPIDER_GLOBAL_ROOT || join(homedir(), ".pi", "agent", "spider");
    try {
      const report = await runLocalDoctor({ root, bundleUrl: options?.bundleUrl });
      io.out(`Roaming is ${report.enabled ? "enabled" : "disabled"}.\n`);
      io.out("sqlite3 CLI requires 3.38 to write a migrated store and 3.42 for roaming capture.\n");
      for (const consumer of report.consumers) io.out(`${clean(consumer.machine)}: ${consumer.kind} PID ${consumer.pid} loaded build ${clean(consumer.build)}${consumer.roamSchema === null ? "" : `, roaming schema ${consumer.roamSchema}`}.\n`);
      for (const diagnostic of report.diagnostics) io.out(`${clean(diagnostic.reason)}\n`);
      return report.diagnostics.some(diagnostic => diagnostic.severity === "block") ? 1 : 0;
    } catch {
      io.err("Cannot inspect local roaming state. No data was changed.\n");
      return 1;
    }
  }
  io.err("This roaming command is unavailable in this build.\n");
  return 1;
}
