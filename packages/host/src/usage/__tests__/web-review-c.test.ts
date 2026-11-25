import { expect, it } from "vitest";
import { PlainDocument } from "./fixtures/plain-dom.js";
import { DashboardClientError, errorCopy } from "../web/client.js";
import { renderTable } from "../web/tables.js";

it("identity recovery names the salt sidecar and failure-cache window", () => {
  const copy = errorCopy(new DashboardClientError("identity-unavailable"));
  expect(copy).toContain("the ledger's salt file"); expect(copy).toContain("five seconds"); expect(copy).not.toContain("Run /usage again");
});
it("period-independent empty tables do not imply a selected time window", () => {
  const doc = new PlainDocument();
  const table = renderTable(doc.asDocument(), { caption: "Loaded rate versions", columns: ["Version"], rows: [] });
  expect(table.textContent).toContain("No rows recorded"); expect(table.textContent).not.toContain("for this period");
});
