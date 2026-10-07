import { dashboardBatch, dashboardCall, DASHBOARD_DAY as DAY, DASHBOARD_MONTH as START, type DashboardFixture } from "./dashboard-ledger.js";

/** Flat counters never fit; rising counters give a hand-derived 0.5 factor. */
export function seedCalibrationHistory(f: DashboardFixture, days: number, fits: boolean): void {
  f.db.exec("DELETE FROM calls; DELETE FROM counter_snapshots");
  f.ledger.apply(dashboardBatch([dashboardCall("history-template", { ts: START, price: { status: "priced", aic: 2,
    components: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } })]));
  const columns = (f.db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map(row => row.name);
  const expressions = columns.map(name => ["id", "entry_id", "fingerprint"].includes(name) ? "'history-'||n"
    : name === "ts" ? `${START}+CAST(n*${DAY}/500.0 AS INTEGER)` : `template.${name}`);
  f.db.raw.transaction(() => {
    f.db.exec(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<${days * 500 - 1})
      INSERT INTO calls (${columns.join(",")}) SELECT ${expressions.join(",")} FROM sequence CROSS JOIN calls template WHERE template.id='history-template'`);
    f.db.exec(`WITH RECURSIVE sequence(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM sequence WHERE n<${days * 144})
      INSERT INTO counter_snapshots(ts,account_login,credits_used,reset_date,raw)
      SELECT ${START}+n*600000,'synthetic-account',${fits ? "n*500.0/144" : "0"},'synthetic-reset','{}' FROM sequence`);
  }).immediate();
}
