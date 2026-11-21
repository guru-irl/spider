// SPDX-License-Identifier: MIT
import { HerdrError } from '@spider/herdr/client/parse';
import { isHerdrConnectivityFailure } from '@spider/herdr/client/availability';
import { herdrErrorNoticeKey } from '@spider/herdr/notices';

export function shouldNotifyHerdrError(error: unknown, outages: Set<string>, messages: Map<string, number>, now: number): boolean {
  const key = herdrErrorNoticeKey(error), last = messages.get(key);
  if (error instanceof HerdrError && isHerdrConnectivityFailure(error) && (error.code === 'unavailable' || Boolean(error.availability?.machine))) {
    const scope = error.availability?.key ?? 'unavailable';
    const keys = [scope, ...(error.availability?.aliases ?? [])];
    const alreadyReported = keys.some(key => outages.has(key));
    for (const key of keys) outages.delete(key);
    outages.add(scope);
    if (alreadyReported) return false;
  } else {
    if (last !== undefined && now >= last && now - last < 60_000) return false;
    messages.set(key, now);
  }
  return true;
}
