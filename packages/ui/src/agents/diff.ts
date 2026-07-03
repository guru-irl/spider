import type { LineChange, LineDiff } from "./types";

export function diffLines(prev: string[], next: string[]): LineDiff {
  const changed: LineChange[] = [];
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) changed.push({ index: i, line: next[i] });
  }
  const lengthChanged = prev.length !== next.length;
  const removedFrom = next.length < prev.length ? next.length : undefined;
  return { changed, removedFrom, lengthChanged };
}

export function hasChanges(d: LineDiff): boolean {
  return d.changed.length > 0 || d.removedFrom !== undefined;
}
