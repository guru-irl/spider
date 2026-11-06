// SPDX-License-Identifier: MIT
import { HERDR_LABELS } from '../contracts.js';
import type { JobRecord, ReleaseObservation, RunId, TerminalAddress, TerminalSummary } from '../contracts.js';

/** An address is not proof of ownership when a terminal can be replaced. */
export function observeJobIdentity(job: JobRecord & { runId?: RunId }, address: TerminalAddress, terminal: TerminalSummary): ReleaseObservation {
  if (terminal.address !== address) return { kind: 'address', expected: address.slice(0, 256), actual: terminal.address.slice(0, 256) };
  const expected: Record<string, string> = {
    [HERDR_LABELS.job]: job.id, [HERDR_LABELS.session]: job.owner.sessionId, [HERDR_LABELS.kind]: job.kind, [HERDR_LABELS.machine]: job.machine,
    [HERDR_LABELS.ownerCore]: job.owner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: job.owner.terminal.terminalId,
    ...(job.runId ? { [HERDR_LABELS.run]: job.runId } : {}),
  };
  const differences = Object.entries(expected).flatMap(([label, value]) => terminal.labels[label] === value ? []
    : [{ label, expected: value.slice(0, 256), actual: terminal.labels[label]?.slice(0, 256) ?? null }]);
  if (!job.runId && terminal.labels[HERDR_LABELS.run] !== undefined) differences.push({ label: HERDR_LABELS.run, expected: '<none>', actual: terminal.labels[HERDR_LABELS.run].slice(0, 256) });
  return differences.length ? { kind: 'labels', differences } : { kind: 'matched' };
}
