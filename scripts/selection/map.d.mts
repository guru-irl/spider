// SPDX-License-Identifier: MIT
export interface SelectionMap {
  version: 1;
  commit: string;
  runId: string;
  createdAt: string;
  files: string[];
  tests: Record<string, {
    /** Indices into files. */
    reads: number[];
    /** Bundle paths for which no source map was found. */
    unresolved: string[];
    ms: number;
    result: 'passed' | 'failed' | 'skipped';
  }>;
}
