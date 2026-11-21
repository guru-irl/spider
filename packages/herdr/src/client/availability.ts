// SPDX-License-Identifier: MIT
import { HerdrError, type Availability } from './parse.js';

export function isHerdrConnectivityFailure(error: unknown): boolean {
  if (!(error instanceof HerdrError)) return false;
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const message = [error.message, details.stderr, details.stdout, details.hint].filter(value => typeof value === 'string').join(' ');
  const normalized = message.replace(/[_-]/g, ' ');
  if (/(?:usage:|unknown (?:option|argument|command)|(?:unrecogni[sz]ed|unexpected|invalid) (?:option|argument)|bad request|permission denied|access denied|unauthenticated|unauthori[sz]ed|forbidden|authentication|invalid credentials|identity mismatch|host key verification|\b(?:401|403)\b)/i.test(normalized)) return false;
  if (error.code === 'unavailable' || error.code === 'unreachable' || error.code === 'cli-timeout') return true;
  if (error.code !== 'cli-exit') return false;
  return /(?:\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|EPIPE)\b|no route to host|network (?:is )?(?:down|unreachable)|host (?:is )?(?:down|unreachable)|broken pipe|temporary failure in name resolution|could not resolve|name or service not known|(?:failed|unable) to connect|(?:cannot|can't|couldn't) connect|(?:connection|network|socket|transport|ssh|remote|host|tunnel).{0,80}(?:unavailable|unreachable|closed|reset|refused|lost|timed?\s*out|timeout|disconnected|down|broken)|\b(?:502|503|504)\b)/i.test(message);
}

export async function trackAvailability<T>(scope: Availability, work: () => Promise<T>, available?: (key: string) => void): Promise<T> {
  try {
    const value = await work();
    try { available?.(scope.key); } catch { /* Reporting cannot fail the completed operation. */ }
    return value;
  } catch (error) {
    if (error instanceof HerdrError && isHerdrConnectivityFailure(error) && !error.availability)
      throw new HerdrError(error.code, error.message, error.details, scope);
    throw error;
  }
}
