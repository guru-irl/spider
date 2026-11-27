import type { Db } from "@spider/db-core";
import { USAGE_V3_DIMENSION_COLUMNS } from "./schema-v3.js";
import type { Dimension } from "./dashboard-contract.js";

// Runtime map is type-checked against the contract, but cannot regenerate v3 SQL.
export const DIMENSION_COLUMNS: Readonly<Record<Dimension, string>> = USAGE_V3_DIMENSION_COLUMNS;
export type DimensionValue = { value: string | null; firstSeen: number; lastSeen: number };

/** Historical non-null raw values, not display labels or id resolution.
 * Missing-value counts are queried from the selected period, not this registry.
 * Values survive deletion/reset for historical enumeration. Dashboard filter-id
 * resolution still uses selected-period values; this registry does not resolve ids. */
export function readDimensionValues(db: Db, dimension: Dimension, page: { limit?: number; after?: string | null } = {}): readonly DimensionValue[] {
  const limit = page.limit ?? 200;
  if (!Object.hasOwn(USAGE_V3_DIMENSION_COLUMNS, dimension) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
    (page.after !== undefined && page.after !== null && typeof page.after !== "string")) throw new TypeError("invalid dimension registry query");
  // v3 skips nulls on every registry write, so has_value is always 1.
  // The null cursor/result branches below are retained for the registry API shape.
  const after = page.after;
  const cursor = after === undefined ? "" : "AND (has_value,value) > (?,?)";
  const rows = db.prepare(`SELECT value,has_value AS hasValue,first_seen AS firstSeen,last_seen AS lastSeen
    FROM dimension_values WHERE dimension=? ${cursor} ORDER BY has_value,value LIMIT ?`)
    .all(dimension, ...(after === undefined ? [] : [after === null ? 0 : 1, after ?? ""]), limit) as
    { value: string; hasValue: number; firstSeen: number; lastSeen: number }[];
  return rows.map(({ value, hasValue, firstSeen, lastSeen }) => ({ value: hasValue === 0 ? null : value, firstSeen, lastSeen }));
}
