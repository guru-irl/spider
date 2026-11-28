// SPDX-License-Identifier: MIT
export interface SelectionMap {
  version: 2;
  commit: string;
  runId: string;
  createdAt: string;
  files: string[];
  tests: Record<string, {
    /** Indices into files. */
    reads: number[];
    /** Bundle paths for which no source map was found. */
    unresolved: string[];
    /** The test built or executed a bundle. */
    ranBundle: boolean;
    /** A process or worker did not leave a complete record. Always select this test. */
    incomplete: boolean;
    ms: number;
    /** Observed Node processes and worker threads, including the test fork. */
    processes: number;
    /** Summed process CPU in milliseconds, or null if any observed process has incomplete CPU. */
    cpuMs: number | null;
    /** Sum of available process CPU checkpoints, a lower bound when CPU is incomplete. */
    knownCpuMs: number;
    /** Processes without a completed CPU measurement. */
    unknownCpu: number;
    /** Subset of unknownCpu without any CPU checkpoint. */
    missingCpu: number;
    /** Failed or skipped tests are always selected because their records may be partial. */
    result: 'passed' | 'failed' | 'skipped';
  }>;
}
