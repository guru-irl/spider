import type { RangeQuery } from "../../dashboard-v4-contract.js";
export function customRange(start: number, end: number): RangeQuery {
  return { range: "custom", from: start, to: end, tz: "UTC", unit: "credits", buckets: [] };
}
