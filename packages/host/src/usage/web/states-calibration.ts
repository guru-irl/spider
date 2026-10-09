import type { CalibrationData, DashboardPageMount } from "../dashboard-v4-contract.js";
import type { FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import { mountCalibration } from "./calibration.js";
import { element } from "./dom.js";
import { renderStateExamples } from "./state-examples.js";
export const page = "calibration";
export const pageMount: DashboardPageMount = mountCalibration;
export async function mountCalibrationStates(root: HTMLElement, cases: readonly FixtureStateCase[]): Promise<void> {
  const examples = cases.filter(c => c.page === "calibration");
  const base = examples.find(c => c.scenario === "default");
  function variant(name: string, change: (data: CalibrationData) => void): FixtureStateCase | undefined {
    if (!base) return undefined;
    const example = structuredClone(base); example.name = `calibration-${name}`;
    const body = example.responses["/api/calibration"]?.body;
    if (!body || !("data" in body)) return undefined;
    change(body.data as CalibrationData); return example;
  }
  const back = variant("back-applied", data => { data.correction.status = "back-applied"; });
  const published = variant("published-only", data => {
    data.correction = { factor: null, publishedEstimate: null, accountCounter: null, coveredHours: 0, status: "published-only" };
    data.intervals = []; data.daily = data.daily.map(d => ({ ...d, counterDelta: null })); data.gaps.daysWithoutCounter = data.daily.map(d => d.day);
  });
  await renderStateExamples(root, { calibration: mountCalibration }, [...examples, ...[back, published].filter((c): c is FixtureStateCase => !!c)]);
  const expanded = variant("expanded-intervals", data => {
    const interval = data.intervals[0]; if (!interval) return;
    // Split the supplied synthetic matched interval without changing its totals.
    const step = (interval.end - interval.start) / 12;
    data.intervals = Array.from({ length: 12 }, (_, i) => ({ start: interval.start + i * step, end: interval.start + (i + 1) * step,
      counterDelta: interval.counterDelta / 12, publishedEstimate: interval.publishedEstimate === null ? null : interval.publishedEstimate / 12, ratio: interval.ratio }));
  });
  if (!expanded) return;
  const extra = element(root.ownerDocument, "div"); root.append(extra);
  const expandedMount: DashboardPageMount = ctx => {
    const mounted = mountCalibration(ctx);
    return { async refresh() {
      await mounted.refresh();
      const expand = (node: Element): void => { if (node.tagName.toLowerCase() === "button" && node.textContent === "Show more") (node as HTMLButtonElement).click(); else for (const child of Array.from(node.children)) expand(child); };
      expand(ctx.root);
    }, dispose: () => mounted.dispose() };
  };
  await renderStateExamples(extra, { calibration: expandedMount }, [expanded]);
}
