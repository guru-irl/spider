// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingAssertions, missingCases } from './check-herdr-test-coverage.mjs';

const source = (path, text) => ({ path, text });

test('matches unchanged assertions moved between files', () => {
  const before = [source('old.ts', "expect(one).toEqual('a b'); expect(two).not.toBe(3);")];
  const after = [source('first.ts', "expect( one ).toEqual('a b');"), source('second.ts', 'expect(two).not.toBe(3);')];
  assert.deepEqual(missingAssertions(before, after), []);
});

test('detects a weakened assertion and a missing duplicate', () => {
  const before = [source('old.ts', "expect(one).toEqual('a b'); expect(one).toEqual('a b'); expect(two).not.toBe(3);")];
  const after = [source('new.ts', "expect(one).toEqual('a b'); expect(one).toEqual('ab'); expect(two).toBe(3);")];
  const missing = missingAssertions(before, after);
  assert.equal(missing.length, 2);
  assert.equal(missing.find(row => row.text.includes("'a b'"))?.count, 1);
  assert.equal(missing.find(row => row.text.includes('not.toBe'))?.count, 1);
});

test('detects weakened or deleted Node assertion calls', () => {
  const before = [source('old.ts', "assert(value); assert.equal(actual, 3); assert.deepEqual(result, ['x']);")];
  const after = [source('new.ts', "assert(value); assert.equal(actual, 4);")];
  const missing = missingAssertions(before, after);
  assert.equal(missing.length, 2);
  assert.ok(missing.some(row => row.text === 'assert.equal(actual, 3)'));
  assert.ok(missing.some(row => row.text === "assert.deepEqual(result, ['x'])"));
});

test('detects deleted and newly skipped cases while allowing extra cases', () => {
  const before = [{ name: 'case a', status: 'passed' }, { name: 'case b', status: 'skipped' }, { name: 'case c', status: 'passed' }];
  const after = [{ name: 'case a', status: 'skipped' }, { name: 'case b', status: 'skipped' }, { name: 'new case', status: 'passed' }];
  assert.deepEqual(missingCases(before, after), [{ name: 'case a', status: 'passed', count: 1 }, { name: 'case c', status: 'passed', count: 1 }]);
});

const packaging = text => [source('packages/herdr/src/__tests__/packaging.test.ts', text)];
const syncValidator = "expect(() => run(['scripts/assert-bundle.mjs', '--root', copy])).toThrow(/invalid/);";
const asyncValidator = "await expect(runAsync(['scripts/assert-bundle.mjs', '--root', copy])).rejects.toThrow(/invalid/);";

test('matches equivalent synchronous and asynchronous package validator assertions', () => {
  assert.deepEqual(missingAssertions(packaging(syncValidator), packaging(asyncValidator)), []);
});

test('rejects changes to the package validator command or expected error', () => {
  for (const changed of [
    asyncValidator.replace('copy', 'another'),
    asyncValidator.replace('/invalid/', '/other/'),
    asyncValidator.replace('.rejects.toThrow', '.rejects.not.toThrow'),
    asyncValidator.replace('runAsync', 'anotherRunner'),
    asyncValidator.replace('await ', ''),
  ]) assert.equal(missingAssertions(packaging(syncValidator), packaging(changed)).length, 1, changed);
  assert.equal(missingAssertions([source('other.ts', syncValidator)], [source('other.ts', asyncValidator)]).length, 1);
});
