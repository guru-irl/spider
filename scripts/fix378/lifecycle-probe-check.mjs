import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const dir = process.env.WPKG_PROBE_ROOT;
const json = JSON.parse(readFileSync(`${dir}/results.json`));
const report = JSON.parse(readFileSync(`${dir}/lifecycle.json`));
assert.equal(json.numFailedTests, 0);
assert.equal(report.modules.length, 1);
assert.deepEqual(report.errors, []);
const row = report.modules[0];
assert.equal(row.state, 'passed');
assert.ok(row.activeMs >= 600, `collection and hooks were omitted: ${row.activeMs}`);
assert.ok(row.diagnostic.collectDuration >= 180, 'collection delay omitted');
assert.ok(row.diagnostic.duration >= 420, 'beforeAll or afterAll omitted');
assert.ok(row.fullMs >= row.activeMs, 'pre-module preparation must not shrink full time');
const jsonSpan = json.testResults[0].endTime - json.testResults[0].startTime;
assert.ok(row.activeMs - jsonSpan >= 500, `JSON span unexpectedly includes hooks/collection: ${jsonSpan}`);
console.log(`lifecycle ${row.activeMs.toFixed(1)} ms, JSON span ${jsonSpan.toFixed(1)} ms`);
