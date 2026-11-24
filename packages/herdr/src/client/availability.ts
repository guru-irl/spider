// SPDX-License-Identifier: MIT
import { HerdrError, type Availability } from './parse.js';

export function isHerdrConnectivityFailure(error: unknown): boolean {
  if (!(error instanceof HerdrError)) return false;
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const message = [error.message, details.stderr, details.stdout, details.hint].filter(value => typeof value === 'string').join(' ');
  const normalized = [error.message, details.stderr].filter(value => typeof value === 'string').join(' ').replace(/[_-]/g, ' ');
  if (/(?:usage:|unknown (?:option|argument|command)|(?:unrecogni[sz]ed|unexpected|invalid) (?:option|argument)|bad request|permission denied|access denied|unauthenticated|unauthori[sz]ed|forbidden|authentication|invalid credentials|identity mismatch|host key verification|\b(?:401|403)\b)/i.test(normalized)) return false;
  if (error.code === 'unavailable' || error.code === 'unreachable' || error.code === 'cli-timeout') return true;
  if (error.code !== 'cli-exit') return false;
  return /(?:\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|EPIPE)\b|\bno route to host\b|\bnetwork (?:is )?(?:down|unreachable)\b|\bhost (?:is )?(?:down|unreachable)\b|\bbroken pipe\b|\btemporary failure in name resolution\b|\bcould not resolve\b|\bname or service not known\b|\b(?:failed|unable) to connect\b|\b(?:cannot|can't|couldn't) connect\b|\b(?:connection|network|socket|transport|ssh|remote|host|tunnel)\b.{0,80}\b(?:unavailable|unreachable|closed|reset|refused|lost(?!\+found\b)|timed?\s*out|timeout|disconnected|down|broken)\b|\b(?:HTTP(?:\/\d(?:\.\d)?)?(?:\s+status(?:\s+code)?)?|status(?:\s+code)?)(?:\s*[:=]\s*|\s+)50[234]\b)/i.test(message);
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
