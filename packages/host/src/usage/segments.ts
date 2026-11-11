import type { MachineId, Segment } from "@spider/db-core/roam/types";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = (): never => { throw Object.assign(new Error("invalid roaming segment"), { code: "invalid-roam-segment" }); };

/** Unknown entries do not affect attribution. Recognized malformed markers fail closed. */
export function readSegment(entry: unknown): Segment | null {
  const item = record(entry);
  if (item?.type !== "custom" || item.customType !== "spider-roam-segment") return null;
  const data = record(item.data), parent = data?.parentRef === null ? null : record(data?.parentRef);
  if (!data || data.version !== 1 || !text(data.moveId) || !Number.isSafeInteger(data.epoch)
    || (data.epoch as number) < 1 || !text(data.previousMachine) || !text(data.nextMachine)
    || !text(data.historyMachine) || data.parentRef !== null && (!parent || !text(parent.machineId) || !text(parent.reference))) invalid();
  return data as unknown as Segment;
}

/** Move ownership follows physical file order, independently of parent links. */
export function segmentMachine(entry: unknown, previous: MachineId | null): MachineId | null {
  const segment = readSegment(entry);
  if (!segment) return previous;
  if (previous !== null && segment.previousMachine !== previous) invalid();
  return segment.nextMachine;
}
