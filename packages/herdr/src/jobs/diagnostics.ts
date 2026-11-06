// SPDX-License-Identifier: MIT
import type { JobRecord, ReleaseFailure, ReleaseObservation } from '../contracts.js';

function prefix(text: string, limit: number): string {
  let result = '', bytes = 0;
  for (const char of text) { const size = Buffer.byteLength(char); if (bytes + size > limit) break; result += char; bytes += size; }
  return result;
}
function suffix(text: string, limit: number): string {
  return [...prefix([...text].reverse().join(''), limit)].reverse().join('');
}
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
function compactObservation(value: ReleaseObservation): ReleaseObservation {
  if (value.kind === 'address') return { kind: 'address', expected: prefix(clean(value.expected), 40), actual: prefix(clean(value.actual), 40) };
  if (value.kind !== 'labels') return value;
  const omitted = (value.omitted ?? 0) + Math.max(0, value.differences.length - 3);
  return { kind: 'labels', differences: value.differences.slice(0, 3).map(difference => ({ label: difference.label,
    expected: prefix(clean(difference.expected), 40), actual: difference.actual === null ? null : prefix(clean(difference.actual), 40) })), ...(omitted ? { omitted } : {}) };
}
function compactFailure(value: ReleaseFailure): ReleaseFailure {
  const confirmation = value.confirmation;
  return { ...value, ...(confirmation ? { confirmation: { ...confirmation, first: compactObservation(confirmation.first), last: compactObservation(confirmation.last) } } : {}) };
}
export function compactFailedPhase(phase: Extract<JobRecord['phase'], { kind: 'launch-failed' }>): Extract<JobRecord['phase'], { kind: 'launch-failed' }> {
  const text = clean(phase.error);
  const error = Buffer.byteLength(text) <= 256 ? text : `${prefix(text, 160)} ... ${suffix(text, 88)}`;
  return { ...phase, error, ...(phase.releaseFailure ? { releaseFailure: compactFailure(phase.releaseFailure) } : {}) };
}
