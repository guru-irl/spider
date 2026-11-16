// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { operationObservation, withHcOperation } from '../client/operation.js';

test('an operation shares in-flight reads with nested steps only', async () => {
  let reads = 0;
  const read = () => operationObservation('core', async () => ++reads);
  await withHcOperation(async () => {
    expect(await Promise.all([read(), withHcOperation(read)])).toEqual([1, 1]);
  });
  expect(await withHcOperation(read)).toBe(2);
});

test('callbacks outliving an operation cannot reuse its observations', async () => {
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = () => operationObservation('core', async () => ++reads);
  let late!: Promise<number>;
  await withHcOperation(async () => {
    expect(await read()).toBe(1);
    late = gate.then(read);
  });
  release();
  expect(await late).toBe(2);
});

test('independent concurrent operations never share an observation', async () => {
  let reads = 0;
  const read = () => operationObservation('core', async () => ++reads);
  expect(await Promise.all([withHcOperation(read), withHcOperation(read)])).toEqual([1, 2]);
});
