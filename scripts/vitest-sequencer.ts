import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { partitionFiles, sortByDuration, type Durations } from './test-shards.js';

const durations: Durations = JSON.parse(readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));

export default class DurationSequencer extends BaseSequencer {
  private path(file: TestSpecification): string {
    return relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/');
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const selected = new Set(partitionFiles(files.map(file => this.path(file)), durations, count)[index - 1]);
    return files.filter(file => selected.has(this.path(file)));
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const byPath = new Map(files.map(file => [this.path(file), file]));
    return sortByDuration([...byPath.keys()], durations).map(path => byPath.get(path)!);
  }
}
