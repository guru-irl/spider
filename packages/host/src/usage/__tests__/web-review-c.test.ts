import { observeFontTransport } from "./fixtures/font-transport.js";
import { afterEach, expect, it, vi } from "vitest";
import { PlainDocument, elements, settle } from "./fixtures/plain-dom.js";
import { DashboardClientError, errorCopy } from "../web/client.js";
import { renderTable } from "../web/tables.js";
import { loadFonts } from "../web/fonts.js";

afterEach(() => vi.unstubAllGlobals());
it("identity recovery names the salt sidecar and failure-cache window", () => {
  const copy = errorCopy(new DashboardClientError("identity-unavailable"));
  expect(copy).toContain("the ledger's salt file"); expect(copy).toContain("five seconds"); expect(copy).not.toContain("Run /usage again");
});
it("optional font request includes every declared local weight", async () => {
  const doc = new PlainDocument(), faces = observeFontTransport(doc); await loadFonts(doc.asDocument(), undefined, () => 1);
  expect(faces.map(face => `${face.family}:${face.weight}`)).toEqual(["Usage Text Remote:400", "Usage Text Remote:500", "Usage Text Remote:600", "Usage Text Remote:700", "Usage Code Remote:400", "Usage Code Remote:700", "Usage Wordmark Remote:400"]);
  expect(elements(doc.head, "link")).toHaveLength(0);
});
it("period-independent empty tables do not imply a selected time window", () => {
  const doc = new PlainDocument();
  const table = renderTable(doc.asDocument(), { caption: "Loaded rate versions", columns: ["Version"], rows: [] });
  expect(table.textContent).toContain("No rows recorded"); expect(table.textContent).not.toContain("for this period");
});
