// Diagnostic reporter. Vitest's JSON timestamps cover only its first and last
// test, so they omit collection and file-level beforeAll/afterAll hooks.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export default class LifecycleReporter {
  starts = new Map();
  rows = new Map();
  errors = [];

  onTestModuleQueued(module) {
    if (this.starts.has(module.moduleId)) this.errors.push(`duplicate start: ${module.moduleId}`);
    this.starts.set(module.moduleId, performance.now());
  }

  onTestModuleEnd(module) {
    const ended = performance.now();
    const started = this.starts.get(module.moduleId);
    const diagnostic = module.diagnostic();
    if (started === undefined) this.errors.push(`missing start: ${module.moduleId}`);
    if (this.rows.has(module.moduleId)) this.errors.push(`duplicate end: ${module.moduleId}`);
    const activeMs = started === undefined ? null : ended - started;
    const prepareMs = diagnostic.prepareDuration;
    this.rows.set(module.moduleId, {
      name: module.moduleId,
      state: module.state(),
      activeMs,
      // Vitest assigns worker preparation to the first module in its batch.
      // It takes place before the enqueue event and includes environment setup.
      fullMs: activeMs === null ? null : activeMs + prepareMs,
      diagnostic,
    });
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const output = process.env.WPKG_LIFECYCLE_REPORT;
    if (!output) throw new Error('WPKG_LIFECYCLE_REPORT is required');
    const rows = modules.map(module => {
      const row = this.rows.get(module.moduleId);
      if (!row) this.errors.push(`missing end: ${module.moduleId}`);
      return row ?? { name: module.moduleId, state: module.state(), activeMs: null, fullMs: null };
    });
    writeFileSync(output, JSON.stringify({ modules: rows, errors: this.errors, unhandledErrors: unhandledErrors.length, reason }, null, 2));
  }
}
