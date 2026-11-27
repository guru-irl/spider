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
    /** Whether the test ran a mapped or unmapped bundle. Absent in older version 1 maps. */
    ranBundle?: boolean;
    ms: number;
    /** Failed or skipped tests are always selected because their records may be partial. */
    result: 'passed' | 'failed' | 'skipped';
  }>;
}
