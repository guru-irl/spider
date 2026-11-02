export type Durations = Readonly<Record<string, number>>;

export function medianDuration(durations: Durations): number {
  const values = Object.values(durations).sort((a, b) => a - b);
  if (!values.length) return 1;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

export function sortByDuration(files: readonly string[], durations: Durations): string[] {
  const fallback = medianDuration(durations);
  return [...files].sort((a, b) => (durations[b] ?? fallback) - (durations[a] ?? fallback)
    || (a < b ? -1 : a > b ? 1 : 0));
}

export function partitionFiles(files: readonly string[], durations: Durations, count: number): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error('shard count must be a positive integer');
  const shards: string[][] = Array.from({ length: count }, () => []);
  const totals = Array<number>(count).fill(0);
  const fallback = medianDuration(durations);
  for (const file of sortByDuration(files, durations)) {
    let lightest = 0;
    for (let index = 1; index < count; index++) {
      if (totals[index]! < totals[lightest]!) lightest = index;
    }
    shards[lightest]!.push(file);
    totals[lightest]! += durations[file] ?? fallback;
  }
  return shards;
}
