// SPDX-License-Identifier: MIT
import { HerdrError } from './client/parse.js';

interface Notice { text: string; action: string | null }
type NoticeCode = 'chainReloaded' | 'chainClosed' | 'killAmbiguous' | 'supervisorStartTimeout' | 'supervisorSignalled' | 'noConfig' | 'outside' | 'coreDown' | 'nested' | 'configProblem' | 'activationProblem' | 'childMissing' | 'childPresence' | 'childCoreLost' | 'coreBack' | 'retired' | 'callerMismatch' | 'repoConfig' | 'repoEnabled' | 'sessionHandoff' | 'sessionBusy' | 'eventsLost' | 'terminalRecords' | 'sshMissing' | 'sshList' | 'sshManaged' | 'sshUnclear' | 'sshHeredoc' | 'sshParse' | 'sshCheck' | 'sshStart' | 'sshBypass' | 'sshPath' | 'sshFile' | 'sshFileMissing' | 'sshBatch' | 'guardOutside' | 'guardConfig' | 'guardChild' | 'guardCore' | 'unsupported' | 'appDisconnected' | 'temporarilyUnavailable' | 'badReply' | 'paneFailed' | 'remoteFailed' | 'remoteStart' | 'remoteNotInstalled' | 'remoteDisabled' | 'outputUnavailable' | 'generic' | 'sessionKillFailed' | 'feedRefresh' | 'viewerFailed' | 'viewNoSession' | 'viewAgents' | 'viewTodos' | 'viewUsage' | 'viewMemory' | 'viewTriggers' | 'templateWorker' | 'templateReviewer' | 'templateWatcher' | 'paneMoveFailed' | 'ownerUnplaced' | 'ownerMoved' | 'commandPaneFailed' | 'paneFull' | 'paneProtected' | 'viewerClosing' | 'runFinished' | 'setupUnplaced';

export function changedSetupFilesNotice(files: readonly { path: string; refusal?: { message: string } }[]): string {
  return `Setup found changed files. Restore the recorded values below, or rerun setup with --replace-changed to back up and replace these files.\n${files.map(file => `  ${file.path}${file.refusal ? `\n    ${file.refusal.message}` : ''}`).join('\n')}`;
}
export function runningSessionUnplacedNotice(name: string): string {
  return `Setup left ${JSON.stringify(name)} running and didn't move or reopen it, because it couldn't confirm that the pane belongs to that session. Run /reload in that session, then run setup again. /herdr-setup prints the command.`;
}
export function switchedSessionNotice(): string {
  return 'This pane now has a different session. Setup will leave that session alone.';
}
export function duplicateSessionNotice(sessionId: string, terminals: readonly string[]): string {
  return `Session ${sessionId} is open in panes ${terminals.join(', ')}. Close one of those sessions, then rerun setup.`;
}
export function installedModMismatchNotice(path: string): { message: string; repair: string } {
  return { message: `Installed spider mods do not match this spider version. Check ${JSON.stringify(path)}.`, repair: 'Run setup again from a plain shell with the selected configuration.' };
}
export function unsupportedHerdrVersionNotice(version: string): string {
  return `This spider version supports Herdr ${version}. Update spider, or use Herdr ${version}.`;
}
export function unknownBuiltInNotice(kind: string, version: string): string {
  return `Herdr's ${kind} built-in does not match version ${version}. Update spider or restore Herdr ${version}, then rerun setup.`;
}
export function renamedSpaceNotice(previous: string, current: string): string {
  return `Space ${JSON.stringify(previous)} is now called ${JSON.stringify(current)}. Setup kept that name.`;
}
export function foreignPanesNotice(space: string, tab: string, terminals: readonly string[]): string {
  return `Space ${JSON.stringify(space)}, tab ${JSON.stringify(tab)}, contains panes ${terminals.join(', ')}. Setup left them alone.`;
}
export function rollbackForeignPanesNotice(space: string, tab: string, terminals: readonly string[]): string {
  return `Space ${JSON.stringify(space)}, tab ${JSON.stringify(tab)}, contains panes ${terminals.join(', ')}. Move or close them before rollback.`;
}

/** Messages are kept here so pi and stderr show the same advice. */
export const HERDR_NOTICES: Readonly<Record<NoticeCode, Notice>> = {
  setupUnplaced: { text: "Setup couldn't confirm a running session's pane. Run /reload in that session, then run setup again. /herdr-setup prints the setup and doctor commands.", action: '/reload' },
  chainReloaded: { text: 'The chain stopped during /reload. These steps did not start. <steps>. Start the remaining steps as a new run.', action: 'Start the remaining steps' },
  chainClosed: { text: 'The chain stopped when the parent session closed. These steps did not start. <steps>. Start the remaining steps as a new run.', action: 'Start the remaining steps' },
  killAmbiguous: { text: 'That ID is ambiguous. Choose a full ID from these matches and try again.', action: 'Choose a full ID' },
  supervisorStartTimeout: { text: "The subagent's supervisor didn't start in time. Start a new run to try again.", action: 'Start a new run' },
  supervisorSignalled: { text: "The subagent's supervisor was stopped by a signal, possibly because Herdr stopped. Start a new run to continue the task.", action: 'Start a new run' },
  noConfig: { text: 'Herdr has no configuration, so its features are off in this session. Everything else in spider still works. Run /herdr-setup for setup and doctor commands.', action: '/herdr-setup' },
  outside: { text: "This session isn't running inside Herdr, so spider's Herdr features are off here. Everything else in spider still works.", action: null },
  coreDown: { text: "Herdr stopped responding, so the sidebar and panes can't follow this session for now. Everything else in spider still works. Run /reload once Herdr is running again.", action: '/reload' },
  nested: { text: "Another pi session already controls this Herdr pane, so spider's Herdr features are off here. Close this session and open a new pane in Herdr.", action: 'Close this session' },
  configProblem: { text: "Spider couldn't read the Herdr configuration, so its Herdr features are off in this session. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  activationProblem: { text: "Spider couldn't start its Herdr features in this session. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  childMissing: { text: "Spider couldn't connect this subagent to its session in Herdr. The subagent can still work locally. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  childPresence: { text: "Spider couldn't connect this subagent to Herdr. The subagent can still work locally. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  childCoreLost: { text: "Herdr stopped responding while this subagent was running, so it can't run commands on other machines for the rest of this run. Finish without remote commands, or report back so the parent can start a new run.", action: 'report back' },
  coreBack: { text: 'Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.', action: '/reload' },
  retired: { text: "This session's Herdr pane belongs to a Herdr instance that has stopped. Close this session and open a new session in Herdr.", action: 'Close this session' },
  callerMismatch: { text: "This session isn't running in the Herdr pane it belongs to, so spider's Herdr features are off here. Close this session and open a new session in Herdr.", action: 'Close this session' },
  repoConfig: { text: "Spider ignores the repository's herdr.config setting. Move it to the global spider settings if you want to use it.", action: 'Move it' },
  repoEnabled: { text: "Spider ignores the repository's herdr.enabled setting. Move it to the global spider settings if you want to use it.", action: 'Move it' },
  sessionHandoff: { text: "Spider couldn't register this session with Herdr, so reopening it later may not work. This session still works. Close and reopen the session in Herdr.", action: 'Close and reopen' },
  sessionBusy: { text: "Spider couldn't open that session because it may already be open elsewhere. Check for another pi session with it open, then close that session and try again.", action: 'Check for another pi session' },
  eventsLost: { text: "Herdr stopped sending updates to this session, so the sidebar and panes may be out of date. Everything else in spider still works. Run /reload to reconnect.", action: '/reload' },
  terminalRecords: { text: "Spider couldn't read some saved Herdr session information. Other Herdr features may still work. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  sshMissing: { text: "Spider couldn't find SSH, so its Herdr features are off in this session. Everything else in spider still works. Install SSH and run /reload.", action: '/reload' },
  sshList: { text: "Spider couldn't check Herdr's machine list, so it blocked this SSH command. Run /reload once Herdr is running. If that doesn't help, run /herdr-setup to print the doctor command for this machine.", action: '/reload' },
  sshManaged: { text: 'Spider blocked SSH to this Herdr-managed machine. Use spider exec with on:<machine> instead.', action: 'spider exec' },
  sshUnclear: { text: "Spider couldn't tell where this SSH command would connect, so it blocked the command. Check the SSH command and try again.", action: 'Check the SSH command' },
  sshHeredoc: { text: 'Spider blocked <command> in a heredoc substitution. Quote the heredoc only if its body is plain data.', action: 'Quote the heredoc' },
  sshParse: { text: "Spider couldn't read this command's quotes or syntax, so it blocked <command>. Check the quotes and syntax, then try again.", action: 'Check the quotes' },
  sshCheck: { text: "Spider couldn't check this SSH command, so the command did not run. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  sshStart: { text: "Spider couldn't start SSH, so the command did not run. Check that SSH is installed and try again.", action: 'Check that SSH is installed' },
  sshBypass: { text: "Spider blocked this command because it tries to bypass Herdr's SSH rules. Remove the bypass and try again.", action: 'Remove the bypass' },
  sshPath: { text: "Spider couldn't read the command because exec_file needs a file path. Add the path and try again.", action: 'Add the path' },
  sshFile: { text: "Spider couldn't read the command file <file>. Check the path and permissions, then try again.", action: 'Check the path' },
  sshFileMissing: { text: "Spider couldn't find the command file <file>. Check the path and try again.", action: 'Check the path' },
  sshBatch: { text: "Spider couldn't read this batch of commands, so none ran. Check the commands and try again.", action: 'Check the commands' },
  guardOutside: { text: "This session isn't running inside Herdr.", action: null },
  guardConfig: { text: "Spider couldn't read the Herdr configuration.", action: null },
  guardChild: { text: "Spider couldn't connect this subagent to Herdr.", action: null },
  guardCore: { text: 'Herdr stopped responding.', action: null },
  unsupported: { text: "Spider couldn't connect to this version of Herdr. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  appDisconnected: { text: "Spider couldn't reach the Herdr app, so it may not be able to open panes. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  temporarilyUnavailable: { text: "Herdr couldn't respond to spider, so some Herdr features may not work. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  badReply: { text: "Herdr sent a response spider couldn't understand, so the sidebar or panes may be out of date. Run /reload once Herdr is running. If that doesn't help, run /herdr-setup to print the doctor command for this machine.", action: '/reload' },
  paneFailed: { text: "Herdr couldn't open a pane for this session. The session and other spider features still work. Try opening the pane again, or run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  paneMoveFailed: { text: "Herdr couldn't open or move this pane. The session still works. Try again.", action: 'Try again' },
  ownerUnplaced: { text: "Herdr couldn't find the session pane, so it couldn't open the viewer. The session still works. Open the session pane and try again.", action: 'Open the session pane' },
  ownerMoved: { text: 'The session moved while Herdr was opening its pane. The session still works. Try opening the pane again.', action: 'Try opening the pane again' },
  commandPaneFailed: { text: "Herdr couldn't open a pane for this command. The command may still be running. Try opening the pane again.", action: 'Try opening the pane again' },
  paneFull: { text: 'This tab has no free pane slot. The session still works. Close a pane and try again.', action: 'Close a pane' },
  paneProtected: { text: "Spider couldn't change this session pane because it is protected. The session still works.", action: null },
  viewerClosing: { text: 'The live viewer is still closing. The run is finished. Open the saved view again.', action: 'Open the saved view again' },
  runFinished: { text: 'This run has already finished. Open its saved view instead.', action: 'Open its saved view' },
  remoteFailed: { text: "Spider couldn't update a remote command in Herdr. The command may still be running. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  remoteStart: { text: "Spider couldn't start the remote command. Your session and local commands still work. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  remoteNotInstalled: { text: "Spider couldn't start the remote command because Herdr isn't set up on that machine. Your session and local commands still work. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  remoteDisabled: { text: "Spider couldn't run this command on another machine because Herdr is off in this session. Local commands still work. Check that Herdr is running and enabled, then run /reload or open a new session in Herdr.", action: '/reload' },
  outputUnavailable: { text: "Spider couldn't read output for job <job> on <machine>. The result shows as unknown for now. The command itself isn't affected.", action: null },
  generic: { text: "Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.", action: '/herdr-setup' },
  sessionKillFailed: { text: 'Subagents stopped, but the terminal could not close. Try Kill session again.', action: 'Kill session' },
  feedRefresh: { text: "Spider couldn't refresh the session list in Herdr. Your sessions may still be running. Run /reload to reconnect.", action: '/reload' },
  viewerFailed: { text: "Spider couldn't open this view in Herdr. The session still works. Close the pane and open the view again.", action: 'Close the pane' },
  viewNoSession: { text: "Spider couldn't open this view because its session is no longer active. Open a session and try again.", action: 'Open a session' },
  viewAgents: { text: "Spider couldn't open the agents view. Try opening it again, or close and reopen the session.", action: 'Try opening it again' },
  viewTodos: { text: "Spider couldn't open the todos view. Try opening it again, or close and reopen the session.", action: 'Try opening it again' },
  viewUsage: { text: "Spider couldn't open the usage view. Try opening it again, or close and reopen the session.", action: 'Try opening it again' },
  viewMemory: { text: "Spider couldn't open the memory view. Try opening it again, or close and reopen the session.", action: 'Try opening it again' },
  viewTriggers: { text: "Spider couldn't open the triggers view. Try opening it again, or close and reopen the session.", action: 'Try opening it again' },
  templateWorker: { text: "Spider couldn't update the Herdr worker shortcut because its model is unavailable. Choose an available worker model in spider's global settings.", action: 'Choose an available worker model' },
  templateReviewer: { text: "Spider couldn't update the Herdr reviewer shortcut because its model is unavailable. Choose an available reviewer model in spider's global settings.", action: 'Choose an available reviewer model' },
  templateWatcher: { text: "Spider couldn't update the Herdr watcher shortcut because its model is unavailable. Choose an available watcher model in spider's global settings.", action: 'Choose an available watcher model' },
};

export type InactiveReason = 'no-config' | 'outside' | 'core-down' | 'nested' | 'config-problem' | 'activation-problem' | 'child-missing' | 'child-presence';
const inactive: Record<InactiveReason, keyof typeof HERDR_NOTICES> = {
  'no-config': 'noConfig', outside: 'outside', 'core-down': 'coreDown', nested: 'nested',
  'config-problem': 'configProblem', 'activation-problem': 'activationProblem',
  'child-missing': 'childMissing', 'child-presence': 'childPresence',
};
export function inactiveHerdrNotice(reason: InactiveReason): string { return HERDR_NOTICES[inactive[reason]].text; }
export function inactiveHerdrGuardNotice(reason: InactiveReason): string {
  const key = reason === 'outside' ? 'guardOutside' : reason === 'no-config' || reason === 'config-problem' ? 'guardConfig' : reason === 'core-down' ? 'guardCore' : 'guardChild';
  return HERDR_NOTICES[key].text;
}

function errorGroup(codes: readonly string[], notice: NoticeCode): Record<string, NoticeCode> {
  return Object.fromEntries(codes.map(code => [code, notice]));
}
const errors: Readonly<Record<string, NoticeCode>> = {
  ...errorGroup(['unsafe-feed-path', 'feed-too-large', 'invalid-feed'], 'feedRefresh'),
  'running-session-unplaced': 'setupUnplaced',
  'lease-token-invalid': 'sessionHandoff', 'session-may-be-live': 'sessionBusy',
  'core-unavailable': 'coreDown', 'terminal-core-mismatch': 'retired', 'core-mismatch': 'retired',
  'events-disconnected': 'eventsLost', 'terminal-registry-bookkeeping': 'terminalRecords', 'output-unavailable': 'outputUnavailable',
  'ssh-unavailable': 'sshMissing', 'invalid-config': 'configProblem', 'unsupported-version': 'unsupported',
  'app-disconnected': 'appDisconnected', unavailable: 'temporarilyUnavailable', 'child-identity-unavailable': 'childPresence',
  'caller-mismatch': 'callerMismatch', 'invalid-reply': 'badReply', 'reply-too-large': 'badReply', 'viewer-usage': 'viewerFailed', 'session-unavailable': 'viewNoSession',
  'core-epoch-unavailable': 'activationProblem', 'invalid-job-journal': 'terminalRecords', 'remote-index-disappeared': 'terminalRecords', 'runtime-not-installed': 'remoteNotInstalled',
  ...errorGroup(['remote-home-invalid', 'remote-home-probe-failed', 'remote-home-probe-timeout', 'runtime-bootstrap-failed', 'runtime-request-invalid'], 'remoteStart'),
  ...errorGroup(['ipc-stream-unavailable', 'wrong-generation', 'owner-session-switched', 'owner-terminal-finished', 'activation-ended'], 'viewerFailed'),
  'pane-timeout': 'paneFailed', 'pane-not-owned': 'paneMoveFailed',
  'owner-unplaced': 'ownerUnplaced', 'owner-tab-changed': 'ownerMoved', 'observer-unplaced': 'commandPaneFailed', 'observer-timeout': 'commandPaneFailed',
  'remote-observer-unavailable': 'generic', 'auxiliary-disabled': 'paneFull', 'agent-pane-protected': 'paneProtected', 'viewer-closing': 'viewerClosing', 'run-finished': 'runFinished',
  ...errorGroup(['invalid-journal', 'invalid-journal-root', 'unsafe-journal-path', 'journal-too-large', 'invalid-session-lease', 'invalid-process-presence', 'invalid-terminal-mapping', 'invalid-state-file', 'unsafe-state-path', 'state-too-large', 'invalid-lock-ticket'], 'terminalRecords'),
  ...errorGroup(['job-owner-mismatch', 'job-not-owned', 'job-not-launched', 'job-outcome-unknown', 'launch-uncertain', 'console-snapshot-timeout', 'console-head-invalid', 'console-ready-timeout', 'console-command-invalid', 'release-timeout', 'observer-job-not-launched', 'invalid-observer-output', 'invalid-observer-gate', 'observer-address-invalid'], 'remoteFailed'),
  ...errorGroup(['caller-probe-unavailable', 'isolation-unproved', 'terminal-identity-mismatch', 'process-identity-unavailable', 'invalid-cli-deadline', 'cli-timeout', 'cli-exit', 'ssh-cache-invalid', 'ssh-cache-core-changed', 'ssh-environment-invalid', 'ssh-self-resolution', 'ssh-parse-failed', 'machine-not-found', 'machine-unconfigured', 'runtime-target-unavailable', 'herdr-unavailable', 'session-file-invalid', 'lock-occupied', 'lock-owner-uncertain', 'role-unresolved', 'catalog-unavailable', 'invalid-template-options', 'invalid-labels', 'remote-parent', 'terminal-may-exist', 'launch-environment-invalid', 'session-explicit-extensions', 'session-id-mismatch', 'not_found', 'aborted', 'disposed', 'cli-aborted', 'explicit-observer-only'], 'generic'),
};
export function herdrErrorNoticeKey(error: unknown): NoticeCode {
  return error instanceof HerdrError && Object.hasOwn(errors, error.code) ? errors[error.code] : 'generic';
}
export function herdrErrorNotice(error: unknown): string {
  if (!(error instanceof HerdrError)) return HERDR_NOTICES.generic.text;
  const known = Object.hasOwn(errors, error.code) ? errors[error.code] : undefined;
  if (known === 'setupUnplaced') {
    const sessions = (error.details as { sessions?: unknown } | undefined)?.sessions;
    if (Array.isArray(sessions) && sessions.length && sessions.every(name => typeof name === 'string')) return sessions.map(runningSessionUnplacedNotice).join('\n');
  }
  if (known === 'outputUnavailable') {
    const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
    const clean = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, limit) || 'unknown' : 'unknown';
    return HERDR_NOTICES.outputUnavailable.text.replace('<job>', clean(details.jobId, 8)).replace('<machine>', clean(details.machine, 100));
  }
  if (known) return HERDR_NOTICES[known].text;
  // Error codes can originate in external replies. Never let them add control characters or prose.
  const code = error.code.replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, 100) || 'unknown';
  return `${HERDR_NOTICES.generic.text.slice(0, -1)} (${code}).`;
}
