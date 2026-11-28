import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLifecycle } from './lifecycle-summary.mjs';

const sample = () => ({
  files: ['packages/herdr/src/__tests__/one.test.ts'],
  report: { reason: 'passed', errors: [], unhandledErrors: 0, modules: [{ name: '/checkout/packages/herdr/src/__tests__/one.test.ts', state: 'passed', activeMs: 44000, fullMs: 44100, diagnostic: { duration: 43500, collectDuration: 400, setupDuration: 0, prepareDuration: 100 } }] },
  json: { success: true, numFailedTests: 0, testResults: [{ name: '/checkout/packages/herdr/src/__tests__/one.test.ts', status: 'passed', startTime: 0, endTime: 43000, assertionResults: [{ fullName: 'one case', status: 'passed' }] }] },
});
test('accepts a complete lifecycle report', () => { const x = sample(); assert.equal(checkLifecycle(x.files, x.report, x.json)[0].fullMs, 44100); });
test('rejects missing and duplicate modules', () => { let x = sample(); x.report.modules = []; assert.throws(() => checkLifecycle(x.files, x.report, x.json)); x = sample(); x.report.modules.push(x.report.modules[0]); assert.throws(() => checkLifecycle(x.files, x.report, x.json)); });
test('rejects failed, incomplete, or unhandled runs', () => { for (const change of [x => x.report.modules[0].state = 'failed', x => x.report.errors.push('missing start'), x => x.report.unhandledErrors = 1, x => x.json.testResults[0].assertionResults = []]) { const x = sample(); change(x); assert.throws(() => checkLifecycle(x.files, x.report, x.json)); } });
test('rejects lifecycle measurements shorter than observed tests or hooks', () => { let x = sample(); x.report.modules[0].activeMs = 100; assert.throws(() => checkLifecycle(x.files, x.report, x.json)); x = sample(); x.report.modules[0].diagnostic.duration = 45000; assert.throws(() => checkLifecycle(x.files, x.report, x.json)); });
test('rejects omitted or invalid worker preparation', () => { for (const val of [null, -1, 43000]) { const x = sample(); x.report.modules[0].fullMs = val; assert.throws(() => checkLifecycle(x.files, x.report, x.json)); } });
test('treats exactly 45 seconds as over the limit', () => { const x = sample(); x.report.modules[0].activeMs = 44900; x.report.modules[0].fullMs = 45000; assert.equal(checkLifecycle(x.files, x.report, x.json)[0].overLimit, true); });
