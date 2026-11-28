import { afterAll, beforeAll, expect, it } from 'vitest';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
await wait(200);
beforeAll(() => wait(200));
afterAll(() => wait(200));
it('runs an observable case between file hooks', async () => {
  await wait(50);
  expect(true).toBe(true);
});
