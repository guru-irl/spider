export function benchmarkSamples<T>(read: () => T, validate?: (value: T) => void): { samplesMs: number[]; p50Ms: number; p95Ms: number; maxMs: number };
export function resolveBenchmarkOutput(checkout: string, output: string): string;
export function withBenchmarkReport<T>(out: string, run: () => Promise<T>): Promise<T>;
export function loadBenchmarkModules(checkout: string): Promise<Record<string, unknown>>;

export function summarizeBenchmarkBudgets<T extends { routes: readonly { route: string; window: string; coldMs: number; p95Ms: number; budgetMs: number | null }[] }>(report: T): T & { allMonthBudgetsMet: boolean; result: "pass" | "fail" };
export function runBenchmarkReport<T extends { routes: readonly { route: string; window: string; coldMs: number; p95Ms: number; budgetMs: number | null }[] }>(out: string, run: () => Promise<T>): Promise<T & { allMonthBudgetsMet: boolean; result: "pass" | "fail" }>;
