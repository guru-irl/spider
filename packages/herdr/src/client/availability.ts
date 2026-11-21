// SPDX-License-Identifier: MIT
import { HerdrError, type Availability } from './parse.js';

export function isHerdrConnectivityFailure(error: unknown): boolean {
  if (!(error instanceof HerdrError)) return false;
  if (error.code === 'unavailable' || error.code === 'unreachable' || error.code === 'cli-timeout') return true;
  if (error.code !== 'cli-exit') return false;
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const message = [error.message, details.stderr, details.stdout].filter(value => typeof value === 'string').join(' ');
  return !/(?:usage:|unknown (?:option|argument|command)|(?:unrecogni[sz]ed|unexpected|invalid) (?:option|argument)|bad request|permission denied|unauthori[sz]ed|forbidden|authentication (?:failed|required)|identity mismatch|host key verification failed)/i.test(message);
}

export async function trackAvailability<T>(scope: Availability, work: () => Promise<T>, available?: (key: string) => void): Promise<T> {
  try {
    const value = await work();
    available?.(scope.key);
    return value;
  } catch (error) {
    if (error instanceof HerdrError && isHerdrConnectivityFailure(error) && !error.availability)
      throw new HerdrError(error.code, error.message, error.details, scope);
    throw error;
  }
}
