import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';

export interface GlobalConfigFixture {
  set(key: string, value: unknown): void;
  restore(): void;
}

/** Capture before a fixture runs, including whether config.json existed at all. */
export function globalConfigFixture(root: string): GlobalConfigFixture {
  const file = join(root, 'config.json');
  const previous = existsSync(file) ? readFileSync(file) : undefined;
  let restored = false;
  return {
    set(key: string, value: unknown): void {
      const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      config[key] = value;
      mkdirSync(root, { recursive: true });
      writeFileSync(file, JSON.stringify(config, null, 2));
    },
    restore(): void {
      if (restored) return;
      if (previous === undefined) rmSync(file, { force: true });
      else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, previous); }
      restored = true;
    },
  };
}

/** Call inside a test; hook-based fixtures use globalConfigFixture and their own teardown. */
export function globalConfigForTest(root: string): GlobalConfigFixture {
  const fixture = globalConfigFixture(root);
  onTestFinished(() => fixture.restore());
  return fixture;
}
