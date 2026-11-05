// SPDX-License-Identifier: MIT
import { HERDR_LABELS as labels, HERDR_KINDS as kinds } from '../contracts.js';
import type { HcClient, Owner, RunId, TerminalSummary } from '../contracts.js';
import { HerdrError } from '../client/parse.js';

export const sameRun = (terminal: TerminalSummary, owner: Owner, runId: RunId): boolean => terminal.state === 'live' && !terminal.address.includes('/')
  && terminal.labels[labels.session] === owner.sessionId && terminal.labels[labels.ownerCore] === owner.terminal.coreId
  && terminal.labels[labels.run] === runId && terminal.labels[labels.kind] === kinds.subagentViewer;
export const isViewer = (terminal: TerminalSummary, owner: Owner, runId: RunId): boolean => sameRun(terminal, owner, runId)
  && terminal.parent === owner.terminal.address && terminal.labels[labels.ownerTerminal] === owner.terminal.terminalId;

export async function recoverViewer(terminal: TerminalSummary, owner: Owner, runId: RunId, hc: HcClient, assertCurrent: () => void): Promise<boolean> {
  if (isViewer(terminal, owner, runId)) return true;
  if (!sameRun(terminal, owner, runId) || !terminal.parent
    || terminal.labels[labels.ownerTerminal] !== terminal.parent && terminal.labels[labels.ownerTerminal] !== owner.terminal.terminalId) return false;
  const previous = await hc.get(terminal.parent).catch(error => {
    if (error instanceof HerdrError && error.code === 'not_found') return null;
    throw error;
  });
  if (previous?.state === 'live') return false;
  assertCurrent();
  await hc.setLabels(terminal.address, { [labels.ownerTerminal]: owner.terminal.terminalId });
  return true;
}
