import { test, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getField, coerce } from '@spider/ui';

const root = resolve('.spider/scratch/compaction-move/config-tests', String(process.pid));
const cwd = join(root, 'cwd'), globalRoot = join(root, 'global'), agentDir = join(root, 'pi');
vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot);
const { configValues, controlConfig, controlDoctor } = await import('../../control.js');
const { applyConfigEdit } = await import('../../control/config-cmd.js');
const { UI_CONFIG_SCHEMA } = await import('../../ui-thinking.js');
const { THINKING_LEVELS } = await import('@spider/db-core');
beforeEach(() => {
  for (const p of [cwd, globalRoot, agentDir, join(cwd, '.spider')]) mkdirSync(p, { recursive: true });
  vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot); vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.stubEnv('GIT_CEILING_DIRECTORIES', root);
  writeFileSync(join(globalRoot, 'config.json'), '{}'); writeFileSync(join(cwd, '.spider/config.json'), '{}');
});
// Break: defaults inadvertently opt in, UI cannot edit the typed fields or ignores shared thinking policy.
test('default compaction leaves summaries to pi and typed UI edits reach the effective config', () => {
  const values = configValues(cwd);
  expect(values.config['compaction.summaryModel']).toBeNull();
  expect(values.config['compaction.fileListCap']).toBe(500);
  expect(values.config['compaction.minSummaryOutputTokens']).toBe(64000);
  expect(getField('compaction.summaryThinking', UI_CONFIG_SCHEMA)?.enum).toEqual(THINKING_LEVELS);
  for (const [key, raw, want] of [
    ['compaction.summaryModel', 'fixture/model/with/slashes', 'fixture/model/with/slashes'],
    ['compaction.summaryModel', 'null', null],
    ['compaction.summaryThinking', 'max', 'max'],
    ['compaction.fileListCap', '0', 0],
    ['compaction.minSummaryOutputTokens', '1600', 1600],
  ] as const) {
    expect(applyConfigEdit(cwd, key, raw).ok).toBe(true);
    expect(configValues(cwd).config[key]).toEqual(want);
    expect(configValues(cwd).sources[key]).toBe('local');
  }
});
// Break: control writes or UI coerce accept malformed settings and unsafe/fractional token values.
const invalid: [string, unknown][] = [
  ['compaction.summaryModel', 'model'], ['compaction.summaryModel', '/model'], ['compaction.summaryModel', 'p/'], ['compaction.summaryModel', 'p/m white'], ['compaction.summaryModel', 3],
  ['compaction.summaryThinking', 'ultra'],
  ['compaction.fileListCap', -1], ['compaction.fileListCap', 1.5], ['compaction.fileListCap', Number.MAX_SAFE_INTEGER + 1],
  ['compaction.minSummaryOutputTokens', -1], ['compaction.minSummaryOutputTokens', 1.5], ['compaction.minSummaryOutputTokens', Number.MAX_SAFE_INTEGER],
];
for (const [key, value] of invalid) test(`rejects invalid ${key} ${JSON.stringify(value)} at both write surfaces`, () => {
  expect(() => controlConfig('set', cwd, key, value)).toThrow(/compaction/);
  const field = getField(key, UI_CONFIG_SCHEMA); expect(field).toBeDefined();
  const raw = String(value);
  expect(coerce(field!, raw).ok).toBe(false);
});
test('raw invalid settings are diagnosed and fail closed while local valid settings win', () => {
  writeFileSync(join(globalRoot, 'config.json'), JSON.stringify({ 'compaction.summaryModel': 'bad', 'compaction.fileListCap': -1 }));
  let values = configValues(cwd);
  expect(values.errors).toHaveLength(2); expect(values.config['compaction.summaryModel']).toBeNull(); expect(values.config['compaction.fileListCap']).toBe(500);
  controlConfig('set', cwd, 'compaction.summaryModel', 'fixture/model');
  values = configValues(cwd); expect(values.config['compaction.summaryModel']).toBe('fixture/model'); expect(values.sources['compaction.summaryModel']).toBe('local');
});
test('doctor reports the legacy child extension with removal and restart instructions', () => {
  const file = join(agentDir, 'per-model-compaction.ts');
  writeFileSync(join(globalRoot, 'config.json'), JSON.stringify({ 'subagents.extensions': [file] }));
  const report = controlDoctor(cwd);
  const line = report.lines.find(line => /legacy extension/.test(line));
  expect(line).toBeDefined(); expect(line).toContain('per-model-compaction.ts'); expect(line).toContain('listed in subagents.extensions (missing file)'); expect(line).not.toContain('remove it'); expect(line).toContain('restart'); expect(report.ok).toBe(false);
});

// Break: doctor loses the installed source or recommends unrelated config edits.
for (const layout of ['per-model-compaction.ts', 'per-model-compaction/index.js']) test(`doctor reports installed legacy ${layout}`, () => {
  const file = join(agentDir, 'extensions', layout);
  mkdirSync(join(agentDir, 'extensions/per-model-compaction'), { recursive: true }); writeFileSync(file, '// fixture');
  try {
    const report = controlDoctor(cwd); const line = report.lines.find(line => /legacy extension/.test(line));
    expect(report.ok).toBe(false); expect(line).toContain('installed in'); expect(line).toContain(layout);
    expect(line).toContain('remove it'); expect(line).not.toContain('subagents.extensions');
  } finally { rmSync(join(agentDir, 'extensions'), { recursive: true }); }
});
