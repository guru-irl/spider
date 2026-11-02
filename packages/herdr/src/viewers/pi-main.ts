// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DefaultResourceLoader, SettingsManager, getAgentDir, type Theme } from '@earendil-works/pi-coding-agent';
import { ProcessTerminal, TuiMainScreen, matchesKey, type TerminalColors } from '@earendil-works/pi-tui';
import { createPiRunView } from './pi-app.js';
import { loadBuiltInRenderers } from './pi-loader.js';
import { SessionTail } from './session-tail.js';
import { RUN_VIEW_PROTOCOL, type RunId, type RunViewInfo } from '../contracts.js';
import type { ViewerPresenter } from './program.js';

export async function startPiViewer(options: { piRoot: string; runId: RunId; cwd: string; scratch: string }): Promise<{ presenter: ViewerPresenter; dispose(): void }> {
  // The host supplies the public components. These theme helpers are the same
  // ones interactive mode uses, but pi does not re-export all of them at root.
  const themes = await import(pathToFileURL(join(options.piRoot, 'dist/modes/interactive/theme/theme.js')).href) as {
    setRegisteredThemes(themes: Theme[]): void; setTerminalColors(colors: TerminalColors): void;
    setTerminalColorScheme(scheme: 'dark' | 'light' | undefined): void; onThemeChange(callback: () => void): void; stopThemeWatcher(): void;
  };
  const settings = SettingsManager.create(options.cwd);
  const resources = new DefaultResourceLoader({ cwd: options.cwd, agentDir: getAgentDir(), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true });
  await resources.reload(); themes.setRegisteredThemes(resources.getThemes().themes);
  const builtInRenderers = await loadBuiltInRenderers(options.piRoot);
  if (!builtInRenderers) throw new Error('The host pi has no built-in tool renderers.');
  mkdirSync(options.scratch, { recursive: true });
  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal, settings.getShowHardwareCursor(), options.scratch);
  const view = createPiRunView({ ui, runName: options.runId, ownerName: null, cwd: options.cwd, builtInRenderers });
  let tail: SessionTail | null = null, sessionFile: string | null = null, quit = () => {};
  let missingNotice = false, disposed = false, runInfo: RunViewInfo | null = null;
  const readSession = () => {
    if (!tail || disposed) return;
    const result = tail.read();
    if (result.missing) return;
    if (result.reset) { view.reset(); if (runInfo) view.setRunInfo(runInfo); }
    if (result.truncatedHead) { view.setHistoryTruncated(); view.notice('Earlier messages are not shown. Showing the saved tail.'); }
    if (result.invalid && !missingNotice) { view.notice('Some saved session records could not be shown.'); missingNotice = true; }
    if (result.entries.length) view.addEntries(result.entries);
  };
  ui.addChild(view.root);
  const inputOff = ui.addInputListener(data => {
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d') && !view.editor?.getText()) { quit(); return { consume: true }; }
    if (matchesKey(data, 'ctrl+o')) { view.toggleTools(); return { consume: true }; }
    if (matchesKey(data, 'ctrl+t')) { view.toggleThinking(); return { consume: true }; }
    return undefined;
  });
  const colorOff = ui.onTerminalColorSchemeChange(scheme => { themes.setTerminalColorScheme(scheme); ui.invalidate(); ui.requestRender(); });
  themes.onThemeChange(() => { if (!disposed) { ui.invalidate(); ui.requestRender(); } });
  ui.start(); ui.setTerminalColorSchemeNotifications(true);
  void ui.queryTerminalColors({ timeoutMs: 100, onLateReply: colors => { if (!disposed) { themes.setTerminalColors(colors); ui.invalidate(); ui.requestRender(); } } })
    .then(colors => { if (!disposed) { themes.setTerminalColors(colors); ui.invalidate(); ui.requestRender(); } });
  const poll = setInterval(readSession, 1000); poll.unref();
  let unreachableTimer: ReturnType<typeof setTimeout> | undefined;
  const presenter: ViewerPresenter = {
    snapshot(run, info) {
      view.setRunName(run.name ?? run.id);
      if (info?.protocol !== RUN_VIEW_PROTOCOL) return;
      runInfo = info;
      if (info.sessionFile && info.sessionFile !== sessionFile) {
        view.reset();
        sessionFile = info.sessionFile; tail = new SessionTail(sessionFile);
      }
      view.setRunInfo(info); readSession();
    },
    page: text => view.text(text),
    live(event) { view.live(event); if (event.type === 'message_end' || event.type === 'tool_execution_end') readSession(); },
    state(state) {
      view.setState(state); clearTimeout(unreachableTimer);
      if (!state.reachable) { unreachableTimer = setTimeout(() => ui.requestRender(), 3100); unreachableTimer.unref(); }
      if (state.status === 'done' || state.status === 'failed' || state.status === 'cancelled') readSession();
    },
    notice: text => view.notice(text), owner: name => view.setOwnerName(name), bindSteer: handler => view.onSteer(handler), onQuit: handler => { quit = handler; },
  };
  return { presenter, dispose() {
    if (disposed) return; readSession(); disposed = true; clearInterval(poll); clearTimeout(unreachableTimer); inputOff(); colorOff();
    themes.stopThemeWatcher(); ui.stop(); view.dispose();
  } };
}
