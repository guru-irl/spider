import { defineConfig, mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import base from "../../vitest.config";

class SparseFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const priority = (file: TestSpecification) => file.moduleId.endsWith("/sparse-inspection.test.ts") ? 0
      : file.moduleId.endsWith("/daemon-cleanup.test.ts") ? 1 : 2;
    return files.sort((a, b) => priority(a) - priority(b));
  }
}

export default mergeConfig(base, defineConfig({ test: { sequence: { sequencer: SparseFirst } } }));
