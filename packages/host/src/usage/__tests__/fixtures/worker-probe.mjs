import "./no-network.mjs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
const roots = workerData?.command?.roots;
if (parentPort && roots) {
  const phase = (name, detail = {}) => parentPort.postMessage({ type: "fixture-phase", name, at: Date.now(), ...detail });
  phase("probe-ready");
  const dlopen = process.dlopen;
  process.dlopen = function(...args) {
    phase("native-load-start");
    try { return dlopen.apply(this, args); }
    finally { phase("native-load-end"); }
  };
  for (const name of ["pragma", "exec"]) {
    const original = Database.prototype[name];
    Database.prototype[name] = function(sql, ...args) {
      const tracked = this.name === roots.ledgerFile && (name === "exec" || /^(journal_mode|user_version|data_version)\b/.test(sql));
      const operation = name === "exec" ? "schema-exec" : sql.split(/\s/)[0];
      if (tracked) phase(`${operation}-start`);
      try { return original.call(this, sql, ...args); }
      catch (error) { if (tracked) phase(`${operation}-error`, { code: error.code }); throw error; }
      finally { if (tracked) phase(`${operation}-end`); }
    };
  }
  for (const name of ["open", "readdir", "realpath", "stat"]) {
    const original = fs[name];
    fs[name] = async function(path, ...args) {
      const source = String(path).startsWith(roots.sessionsDir + "/");
      const tracked = source || String(path) === roots.sessionsDir || String(path) === roots.registryDb;
      if (name === "open" && source) parentPort.postMessage({ type: "fixture-source-read" });
      if (tracked) phase(`${name}-start`);
      try {
        const result = await original.call(this, path, ...args);
        if (name === "open" && source) {
          const read = result.read;
          result.read = async function(...values) {
            phase("source-read-start");
            try {
              const result = await read.apply(this, values);
              phase("source-read-end", { bytesRead: result.bytesRead });
              return result;
            } catch (error) { phase("source-read-error", { code: error.code }); throw error; }
          };
        }
        return result;
      } finally { if (tracked) phase(`${name}-end`); }
    };
  }
  // Pause only the first opener, after its lease transaction has committed and
  // before the first cycle can renew it. The parent holds a real SQLite writer.
  const gate = workerData.fixtureCycleGate;
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = function(callback, delay, ...args) {
    if (gate && delay === 0 && Atomics.load(gate, 0) === 0) {
      const ledger = new Database(roots.ledgerFile, { readonly: true, fileMustExist: true });
      let owner;
      try { owner = ledger.prepare("SELECT owner FROM leases WHERE name='ingest'").get()?.owner; }
      finally { ledger.close(); }
      if (owner === workerData.command.owner && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
        phase("before-first-cycle");
        if (Atomics.wait(gate, 1, 0, 10000) === "timed-out") throw new Error("fixture cycle gate deadline");
      }
    }
    phase("timer-scheduled", { delayMs: delay });
    return timeout(function(...values) {
      phase("timer-fired", { delayMs: delay });
      return callback.apply(this, values);
    }, delay, ...args);
  };
  syncBuiltinESMExports();
}
