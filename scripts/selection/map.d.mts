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
    ms: number;
    result: 'passed' | 'failed' | 'skipped';
  }>;
}
