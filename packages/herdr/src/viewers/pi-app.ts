// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Draws a subagent run with pi's own interactive components, so a viewer pane
// reads like a pi session. This module is bundled separately (viewer-pi.mjs):
// its pi imports resolve to the host's pi install, never to a copy in spider.
import {
  AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, CustomEditor, CustomMessageComponent,
  SettingsManager, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent,
  calculateContextTokens, estimateTokens, getMarkdownTheme, getSelectListTheme, initTheme, parseSkillBlock, sessionEntryToContextMessages, type ReadonlyFooterDataProvider, type Theme,
} from '@earendil-works/pi-coding-agent';
import { Box, Container, Editor, Spacer, Text, TruncatedText, getKeybindings, truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { bindToolCardShell, isHalfEdge, joinToolCards } from '@spider/ui';
import { renderSpiderCall, renderSpiderResult } from '../../../host/src/render-result.js';
import { restoreExecDetails } from '../../../host/src/exec-session-storage.js';
import { createBandEditor } from '../../../host/src/input-band/editor.js';
import { FooterAccumulator } from '../../../host/src/usage/footer-state.js';
import { createUsageFooter, type FooterInput } from '../../../host/src/usage/footer.js';
import { calibrationFallback } from '../../../host/src/usage/calibration.js';
import type { SteerReply, RunViewInfo } from '../contracts.js';
import type { ViewerState } from './program.js';
import { TranscriptSanitizer } from './transcript.js';

type Json = Record<string, any>;
function sanitize<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return new TranscriptSanitizer().push(value) as T;
  if (!value || typeof value !== 'object') return value;
  if (depth > 64) return null as T;
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, depth + 1)])) as T;
}
function restoreForView(result: Json): Json {
  const restored = restoreExecDetails(result.details, result.content);
  // The renderer must not recheck references against sanitized content.
  const consume = (entry: any) => {
    if (!entry || typeof entry !== 'object' || !('spiderOutputRefs' in entry)) return entry;
    const copy = { ...entry };
    if (restored.valid) delete copy.spiderOutputRefs;
    else copy.spiderOutputRefs = null;
    return copy;
  };
  const details = restored.valid ? restored.details : result.details;
  return { ...result, details: Array.isArray(details) ? details.map(consume) : consume(details) };
}
const isSpider = (name: unknown) => name === 'spider' || name === 'spider_exec';
const BandEditor = createBandEditor(CustomEditor);
// pi keeps its active theme on globalThis so every loader shares one; the root does not export it.
const THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme');
const theme = new Proxy({} as Theme, { get: (_target, key) => {
  const active = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
  if (!active) throw new Error('pi theme is not initialised');
  const value = Reflect.get(active, key); return typeof value === 'function' ? value.bind(active) : value;
} });
export interface ToolRenderers { renderCall?: unknown; renderResult?: unknown }
export interface PiRunViewOptions {
  ui: TUI;
  runName: string; ownerName: string | null; cwd: string | null;
  /** The pi theme name. Omitted, it comes from pi's settings, as pi itself does. */
  themeName?: string;
  now?: () => number;
  /** Top-level transcript items kept on screen. Older ones are dropped, like a scrollback limit. */
  maxItems?: number;
  /** Built-in tool renderers from the host pi (core/tools/renderers). */
  builtInRenderers?: (toolName: string) => ToolRenderers | undefined;
  contextWindow?: (provider: string, model: string) => number | undefined;
}
export type ViewState = ViewerState;
export interface PiRunView {
  readonly root: Component;
  editor: Editor | null;
  render(width: number): string[];
  footerLines(width: number): string[];
  addEntries(entries: readonly unknown[]): void;
  live(event: unknown): void;
  setState(state: ViewState): void;
  setOwnerName(name: string | null): void;
  setRunName(name: string): void;
  setRunInfo(info: RunViewInfo): void;
  setHistoryTruncated(): void;
  reset(): void;
  toggleThinking(): void;
  toggleTools(): void;
  notice(text: string): void;
  /** Plain text from an owner that predates the pi view. */
  text(text: string): void;
  onSteer(handler: (text: string) => Promise<SteerReply | null>): void;
  itemCount(): number;
  dispose(): void;
}
const spiderRenderers = {
  renderCall: renderSpiderCall,
  renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => renderSpiderResult(result, options, theme, context),
};
const userText = (message: Json): string => typeof message.content === 'string' ? message.content
  : Array.isArray(message.content) ? message.content.filter((part: Json) => part?.type === 'text').map((part: Json) => part.text).join('') : '';
const messageKey = (message: Json): string | null => typeof message?.timestamp === 'number' ? `${message.role}:${message.timestamp}` : null;

export function createPiRunView(options: PiRunViewOptions): PiRunView {
  const now = options.now ?? Date.now; const maxItems = Math.max(20, options.maxItems ?? 400);
  let settings: SettingsManager | undefined;
  try { settings = SettingsManager.create(options.cwd ?? process.cwd()); } catch { /* Defaults stand in for unreadable settings. */ }
  initTheme(options.themeName ?? settings?.getTheme(), false);
  let hideThinking = settings?.getHideThinkingBlock() ?? false;
  let expanded = false;
  const outputPad = settings?.getOutputPad() ?? 1;
  const markdown = getMarkdownTheme();
  const toolOptions = { showImages: false, imageWidthCells: settings?.getImageWidthCells() ?? 60, outputPad };
  const ui = options.ui;

  const chat = new Container(); const pending = new Container(); const editorSlot = new Container();
  const renderChat = chat.render;
  chat.render = function (width) {
    const rows = renderChat.call(this, width);
    return joinToolCards(this, rows, width, child => child instanceof ToolExecutionComponent, isHalfEdge);
  };
  const hiddenNotice = new Text('', 1, 0); let hidden = 0;
  const tools = new Map<string, ToolExecutionComponent>();
  const streaming = new Map<string, AssistantMessageComponent>();
  const finished = new Set<string>(); // Message keys whose final content is shown.
  const users = new Set<string>();
  const steers: { text: string; state: string; failed: boolean }[] = [];
  let cwd = options.cwd; let ownerName = sanitize(options.ownerName); let runName = sanitize(options.runName);
  let runInfo: RunViewInfo | null = null; let partialHistory = false; let fallbackNotice = false;
  let model: { provider: string; id: string } | null = null; let thinking: string | null = null;
  const totals = new FooterAccumulator();
  let contextTokens: number | null = null; let contextAnchorAt: number | null = null; let contextFloorAt: number | null = null;
  let latestAssistantAt: number | null = null; let latestUsageAt: number | null = null; let latestCacheHitRate: number | null = null;
  const earlier = (at: number | null, reference: number | null) => at !== null && reference !== null && at < reference;
  const messageTime = (message: Json) => typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp : null;
  const entryTime = (entry: Json) => { const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN; return Number.isFinite(at) ? at : null; };
  let state: ViewState = { status: null, steerable: false, reachable: true, readOnlyReason: null };
  let unreachableSince: number | null = null;
  let steerHandler: ((text: string) => Promise<SteerReply | null>) | null = null;
  let editor: Editor | null = null; let parkedEditor: Editor | null = null; let editorBand = true;
  const remember = (keys: Set<string>, key: string) => {
    keys.add(key); while (keys.size > maxItems * 4) keys.delete(keys.values().next().value!);
  };

  const definition = (name: string): ToolRenderers | undefined => name === 'spider' ? spiderRenderers : options.builtInRenderers?.(name);
  const add = (component: Component, spaced = false) => {
    if (spaced && chat.children.length) chat.addChild(new Spacer(1));
    chat.addChild(component); trim();
  };
  function trim() {
    let removed = false;
    while (chat.children.length > maxItems) {
      const first = chat.children[0]; chat.removeChild(first); removed = true;
      if (!(first instanceof Spacer)) hidden++;
      for (const [id, tool] of tools) if (tool === first) tools.delete(id);
      for (const [id, component] of streaming) if (component === first) streaming.delete(id);
    }
    if (removed) hiddenNotice.setText(theme.fg('dim', `Earlier messages are not shown (${hidden} hidden).`));
  }
  const padded = (value: unknown): value is Component => {
    if (!(value instanceof Box) && !(value instanceof Text)) return false;
    const shell = value as unknown as { paddingY: unknown; paddingX: unknown };
    return shell.paddingY === 1 && typeof shell.paddingX === 'number';
  };
  const toolComponent = (id: string, name: string, args: unknown): ToolExecutionComponent => {
    let component = tools.get(id);
    if (!component) {
      component = new ToolExecutionComponent(name, id, args, toolOptions, definition(name) as never, ui, cwd ?? process.cwd());
      const render = component.render;
      component.render = function (width) {
        bindToolCardShell(this, padded, () => true);
        return render.call(this, width);
      };
      component.setExpanded(expanded);
      tools.set(id, component); add(component);
    }
    return component;
  };
  const assistantTools = (message: Json, complete: boolean) => {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type !== 'toolCall' || typeof part.id !== 'string') continue;
      const known = tools.has(part.id); const component = toolComponent(part.id, String(part.name), part.arguments);
      if (known) component.updateArgs(part.arguments);
      if (!complete) continue;
      if (message.stopReason === 'aborted' || message.stopReason === 'error')
        component.updateResult({ content: [{ type: 'text', text: message.errorMessage || (message.stopReason === 'aborted' ? 'Operation aborted' : 'Error') }], isError: true });
      else component.setArgsComplete();
    }
  };
  const addUsage = (entry: Json) => { totals.append([entry]); };
  const addContext = (message: Json) => {
    if (contextTokens === null || earlier(messageTime(message), contextAnchorAt)) return;
    try {
      const trailing = estimateTokens(message as never);
      contextTokens = Number.isFinite(trailing) && trailing >= 0 ? contextTokens + trailing : null;
    } catch { contextTokens = null; }
  };
  const noteAssistant = (message: Json, entry?: Json) => {
    const at = messageTime(message); const usage = message.usage;
    addUsage(entry ?? { type: 'message', message });
    if (!earlier(at, latestAssistantAt)) {
      if (at !== null) latestAssistantAt = at;
      if (typeof message.provider === 'string' && typeof (message.responseModel ?? message.model) === 'string') model = { provider: message.provider, id: message.responseModel ?? message.model };
      if (typeof message.thinkingLevel === 'string') { thinking = message.thinkingLevel; refreshEditorBorder(); }
    }
    if (usage && typeof usage === 'object' && !earlier(at, latestUsageAt)) {
      if (at !== null) latestUsageAt = at;
      latestCacheHitRate = totals.snapshot().latestCacheHitRate;
    }
    if (usage && typeof usage === 'object' && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
      const tokens = calculateContextTokens(usage as never);
      if (Number.isFinite(tokens) && tokens > 0) {
        if (!earlier(at, contextAnchorAt) && !earlier(at, contextFloorAt)) { contextTokens = tokens; contextAnchorAt = at; }
        return;
      }
    }
    addContext(message);
  };
  const compactContext = (entry: Json) => {
    const at = entryTime(entry);
    if (earlier(at, contextAnchorAt) || earlier(at, contextFloorAt)) return;
    contextTokens = null; contextAnchorAt = null; contextFloorAt = at;
  };
  const addUser = (message: Json) => {
    const key = messageKey(message); if (key && users.has(key)) return; if (key) remember(users, key);
    addContext(message);
    const text = userText(message); if (!text) return;
    const index = steers.findIndex(steer => steer.text.trim() === text.trim() && !steer.failed);
    if (index >= 0) { steers.splice(index, 1); renderSteers(); }
    const skill = parseSkillBlock(text);
    if (skill) {
      const component = new SkillInvocationMessageComponent(skill, markdown, outputPad); add(component, true);
      if (skill.userMessage) add(new UserMessageComponent(skill.userMessage, markdown, outputPad), true);
    } else add(new UserMessageComponent(text, markdown, outputPad), true);
  };
  const addMessage = (message: Json, entry?: Json) => {
    switch (message.role) {
      case 'user': addUser(message); break;
      case 'assistant': {
        const key = messageKey(message);
        const live = key ? streaming.get(key) : undefined;
        if (key && finished.has(key) && !live) break;
        noteAssistant(message, entry);
        if (live) { live.updateContent(message as never, false); streaming.delete(key!); }
        else add(new AssistantMessageComponent(message as never, hideThinking, markdown, undefined, outputPad));
        if (key) remember(finished, key);
        assistantTools(message, true);
        break;
      }
      case 'toolResult': {
        addUsage(entry ?? { type: 'message', message }); addContext(message);
        const component = tools.get(message.toolCallId);
        if (component) component.updateResult(message as never);
        break;
      }
      case 'bashExecution': {
        if (!message.excludeFromContext) addContext(message);
        const component = new BashExecutionComponent(message.command, ui, message.excludeFromContext, outputPad);
        if (message.output) component.appendOutput(message.output);
        component.setComplete(message.exitCode, message.cancelled, message.truncated ? { truncated: true } as never : undefined, message.fullOutputPath);
        add(component); break;
      }
      case 'custom':
        addContext(message);
        if (message.display) add(new CustomMessageComponent(message as never, undefined, markdown, outputPad));
        break;
      case 'compactionSummary': add(new CompactionSummaryMessageComponent(message as never, markdown, outputPad), true); break;
      case 'branchSummary': addContext(message); add(new BranchSummaryMessageComponent(message as never, markdown, outputPad), true); break;
      default: break;
    }
  };
  const addEntry = (entry: Json) => {
    switch (entry.type) {
      case 'session': if (typeof entry.cwd === 'string') cwd = entry.cwd; return;
      case 'model_change': if (!earlier(entryTime(entry), latestAssistantAt) && typeof entry.provider === 'string' && typeof entry.modelId === 'string') model = { provider: entry.provider, id: entry.modelId }; return;
      case 'usage': addUsage(entry); return;
      case 'compaction': compactContext(entry); addUsage(entry); break;
      case 'branch_summary': addUsage(entry); break;
      case 'thinking_level_change': if (!earlier(entryTime(entry), latestAssistantAt) && typeof entry.thinkingLevel === 'string') { thinking = entry.thinkingLevel; refreshEditorBorder(); } return;
    }
    let messages: Json[];
    try { messages = sessionEntryToContextMessages(entry as never) as Json[]; } catch { return; }
    for (const message of messages) addMessage(message, entry);
  };

  const renderSteers = () => {
    pending.clear();
    if (!steers.length) return;
    pending.addChild(new Spacer(1));
    for (const steer of steers) {
      const label = steer.failed ? theme.fg('error', `Steer not delivered: ${steer.text}`) : theme.fg('dim', `Steering: ${steer.text}`);
      pending.addChild(new TruncatedText(label, 1, 0));
      if (steer.state) pending.addChild(new Text(theme.fg(steer.failed ? 'error' : 'dim', sanitize(steer.state)), 1, 0));
    }
  };
  const submit = (raw: string) => {
    const text = raw.trim(); if (!text) return;
    if (!state.steerable || !steerHandler) { editor?.setText(raw); notice(`Not sent. ${state.readOnlyReason ?? 'This run cannot be steered now.'}`); return; }
    const steer = { text, state: 'sending', failed: false }; steers.push(steer); renderSteers(); editor?.setText(''); ui.requestRender();
    steerHandler(text).then(reply => {
      if (!reply) { steer.state = 'no reply yet, delivery unknown. Do not resend.'; }
      else if (!reply.accepted) { steer.failed = true; steer.state = reply.error ? `${reply.delivery}. ${reply.error}` : reply.delivery; }
      else steer.state = reply.delivery;
    }, () => { steer.state = 'no reply yet, delivery unknown. Do not resend.'; }).finally(() => { renderSteers(); ui.requestRender(); });
  };
  const refreshEditorBorder = () => { if (editor) editor.borderColor = theme.getThinkingBorderColor((thinking ?? 'off') as never); };
  const syncEditor = () => {
    const showEditor = state.steerable || state.canCompose === true;
    const useBand = runInfo?.inputBand !== false;
    let draft: string | undefined;
    if (showEditor && (editor || parkedEditor) && editorBand !== useBand) {
      draft = (editor ?? parkedEditor)!.getText();
      if (editor) { editorSlot.clear(); (ui as Partial<TUI>).setFocus?.(null); }
      editor = null; parkedEditor = null;
    }
    if (showEditor && !editor) {
      const editorTheme = { borderColor: (text: string) => theme.fg('borderMuted', text), selectList: getSelectListTheme() };
      editor = parkedEditor ?? (useBand
        ? new BandEditor(ui, editorTheme, getKeybindings() as unknown as ConstructorParameters<typeof BandEditor>[2], () => theme)
        : new Editor(ui, editorTheme, { paddingX: 1 }));
      editorBand = useBand; parkedEditor = null;
      if (draft !== undefined) editor.setText(draft);
      refreshEditorBorder(); editor.onSubmit = submit;
      editorSlot.addChild(editor); (ui as Partial<TUI>).setFocus?.(editor);
    } else if (!showEditor && editor) {
      editorSlot.clear(); (ui as Partial<TUI>).setFocus?.(null); parkedEditor = editor; editor = null;
    }
  };

  const footerData: ReadonlyFooterDataProvider = {
    getGitBranch: () => null, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 0,
    onBranchChange: () => () => {},
  };
  const footerInput = (): FooterInput => {
    const snapshot = { ...totals.snapshot(), latestCacheHitRate };
    const modelRef = model ? `${model.provider}/${model.id}` : null;
    const matchesInfo = modelRef !== null && runInfo?.model === modelRef;
    const window = model ? options.contextWindow?.(model.provider, model.id) ?? (matchesInfo ? runInfo?.contextWindow : undefined) : undefined;
    const factor = runInfo?.creditFactor;
    return {
      cwd: '', branch: null, sessionName: null, modelId: model?.id ?? 'no model yet',
      modelName: matchesInfo ? runInfo?.modelName : null, thinking: thinking ?? 'thinking unknown',
      context: window ? { percent: contextTokens === null ? null : contextTokens / window * 100, contextWindow: window } : null,
      subscription: false, totals: snapshot, counter: { availability: 'disabled', snapshot: null }, statuses: new Map(),
      calibration: factor == null ? undefined : { ...calibrationFallback(), status: 'calibrated', factor },
      inPane: true, iconStyle: runInfo?.iconStyle ?? 'text',
      subagent: { contextTokens, creditsKnown: !partialHistory && snapshot.unpricedEntries === 0 },
    };
  };
  const usageFooter = createUsageFooter(footerInput, theme, footerData, () => ui.requestRender());
  let working = false;
  const setWorking = (active: boolean) => {
    if (working === active) return;
    working = active; usageFooter.setWorking(active ? Date.now() : undefined);
  };
  const footer: Component = {
    render(width: number): string[] {
      const sep = theme.fg('dim', ' • ');
      const identity = [theme.fg('dim', runName), theme.fg('dim', ownerName ? `from ${ownerName}` : 'owner unknown')].join(sep);
      const parts: string[] = [];
      const status = state.status ? `${state.statusIsStale ? 'last known ' : ''}${state.status}` : 'waiting';
      if (state.status !== 'running' || state.statusIsStale) parts.push(state.status === 'failed' ? theme.fg('error', status) : theme.fg('dim', status));
      if (!state.reachable && unreachableSince !== null && now() - unreachableSince >= 3000) parts.push(theme.fg('warning', 'owner unreachable'));
      if (!state.steerable && !state.canCompose) parts.push(theme.fg('dim', 'read-only'));
      if (partialHistory) parts.push(theme.fg('dim', 'tail totals'));
      const statusText = parts.join(sep);
      const identityWidth = Math.max(0, width - visibleWidth(statusText) - (statusText ? 3 : 0));
      const shownIdentity = identityWidth > 0 ? truncateToWidth(identity, identityWidth, '...') : '';
      const first = !statusText ? shownIdentity : shownIdentity
        ? shownIdentity + ' '.repeat(Math.max(1, width - visibleWidth(shownIdentity) - visibleWidth(statusText))) + statusText
        : truncateToWidth(statusText, width, '');
      return [first, ...usageFooter.render(width)];
    },
    invalidate() { usageFooter.invalidate(); },
  };
  const footerBox = new Container(); footerBox.addChild(new Spacer(1)); footerBox.addChild(footer);
  const root = new Container();
  root.addChild(hiddenNotice); root.addChild(chat); root.addChild(pending); root.addChild(editorSlot); root.addChild(footerBox);

  function notice(text: string) { add(new Text(theme.fg('dim', text), 1, 0), true); ui.requestRender(); }
  return {
    root,
    get editor() { return editor; },
    set editor(value) { editor = value; },
    render: width => root.render(width),
    footerLines: width => footer.render(width),
    addEntries(entries) {
      let list = entries as readonly Json[];
      // Rendering stays bounded: a long backlog only builds its tail.
      const keep = maxItems * 2;
      if (list.length > keep) {
        const skipped = list.slice(0, list.length - keep);
        for (const raw of skipped) {
          const entry = sanitize(raw);
          if (entry?.type === 'session' && typeof entry.cwd === 'string') cwd = entry.cwd;
          else if (entry?.type === 'model_change' && !earlier(entryTime(entry), latestAssistantAt) && typeof entry.provider === 'string') model = { provider: entry.provider, id: entry.modelId };
          else if (entry?.type === 'thinking_level_change' && !earlier(entryTime(entry), latestAssistantAt)) thinking = entry.thinkingLevel;
          else if (entry?.type === 'usage' || entry?.type === 'branch_summary') addUsage(entry);
          else if (entry?.type === 'compaction') { compactContext(entry); addUsage(entry); }
          else if (entry?.type === 'message' && entry.message?.role === 'assistant') { noteAssistant(entry.message, entry); hidden++; }
          else if (entry?.type === 'message') { if (entry.message?.role === 'toolResult') addUsage(entry); addContext(entry.message); hidden++; }
        }
        list = list.slice(-keep);
        hiddenNotice.setText(theme.fg('dim', `Earlier messages are not shown (${hidden} hidden).`));
      }
      for (const entry of list) if (entry && typeof entry === 'object') {
        const message = entry.message;
        const raw = entry.type === 'message' && message?.role === 'toolResult' && isSpider(message.toolName)
          ? { ...entry, message: restoreForView(message) } : entry;
        addEntry(sanitize(raw));
      }
      // Only a bounded overlap can arrive again from live previews and disk.
      for (const keys of [finished, users]) while (keys.size > maxItems * 4) keys.delete(keys.values().next().value!);
      ui.requestRender();
    },
    live(raw) {
      if (!raw || typeof raw !== 'object') return;
      const input = raw as Json;
      const restored = input.type === 'tool_execution_end' && isSpider(input.toolName) && input.result
        ? { ...input, result: restoreForView(input.result) } : input;
      const event = sanitize(restored);
      switch (event.type) {
        case 'agent_start':
          if (runInfo) runInfo = { ...runInfo, working: true };
          setWorking(state.status === 'running' && !state.statusIsStale); break;
        case 'agent_end':
          if (runInfo) runInfo = { ...runInfo, working: false };
          setWorking(false); break;
        case 'message_start': case 'message_update': case 'message_end': {
          const message = event.message as Json; if (message?.role !== 'assistant') return;
          const key = messageKey(message); if (!key || finished.has(key)) return;
          let component = streaming.get(key);
          if (!component) { component = new AssistantMessageComponent(undefined, hideThinking, markdown, undefined, outputPad); streaming.set(key, component); add(component); }
          component.updateContent(message as never, event.type !== 'message_end');
          assistantTools(message, event.type === 'message_end');
          if (event.type === 'message_end') { streaming.delete(key); remember(finished, key); noteAssistant(message); }
          break;
        }
        case 'tool_execution_start': if (typeof event.toolCallId === 'string') toolComponent(event.toolCallId, String(event.toolName), event.args).markExecutionStarted(); break;
        case 'tool_execution_update': tools.get(event.toolCallId)?.updateResult({ ...(event.partialResult ?? {}), isError: false } as never, true); break;
        case 'tool_execution_end': tools.get(event.toolCallId)?.updateResult({ ...(event.result ?? {}), isError: Boolean(event.isError), durationMs: event.durationMs } as never); break;
        default: return;
      }
      ui.requestRender();
    },
    setState(next) {
      if (!next.reachable) unreachableSince ??= next.unreachableSince ?? now(); else unreachableSince = null;
      const wasLive = state.status === 'running' && !state.statusIsStale;
      const isLive = next.status === 'running' && !next.statusIsStale;
      state = next;
      if (!isLive) setWorking(false); else if (!wasLive) setWorking(runInfo?.working ?? true);
      syncEditor(); ui.requestRender();
    },
    setOwnerName(name) { ownerName = sanitize(name); ui.requestRender(); },
    setRunName(name) { runName = sanitize(name); ui.requestRender(); },
    setRunInfo(info) {
      runInfo = sanitize(info);
      if (!model && runInfo.model) {
        const slash = runInfo.model.indexOf('/');
        model = { provider: slash >= 0 ? runInfo.model.slice(0, slash) : '', id: runInfo.model.slice(slash + 1) };
      }
      thinking ??= runInfo.thinking ?? null;
      if (state.status === 'running' && !state.statusIsStale && typeof runInfo.working === 'boolean') setWorking(runInfo.working);
      syncEditor(); refreshEditorBorder(); ui.requestRender();
    },
    setHistoryTruncated() { partialHistory = true; ui.requestRender(); },
    reset() {
      chat.clear(); tools.clear(); streaming.clear(); finished.clear(); users.clear(); hidden = 0; hiddenNotice.setText('');
      totals.reset([]); contextTokens = null; contextAnchorAt = null; contextFloorAt = null;
      latestAssistantAt = null; latestUsageAt = null; latestCacheHitRate = null;
      model = null; thinking = null; partialHistory = false; fallbackNotice = false;
      ui.requestRender();
    },
    toggleThinking() {
      hideThinking = !hideThinking;
      for (const child of chat.children) if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(hideThinking);
      ui.requestRender();
    },
    toggleTools() {
      expanded = !expanded;
      for (const child of chat.children) if ('setExpanded' in child && typeof child.setExpanded === 'function') child.setExpanded(expanded);
      ui.requestRender();
    },
    notice,
    text(text) {
      if (text.trim()) {
        if (!fallbackNotice) { add(new Text(theme.fg('dim', 'Saved transcript unavailable. Showing recorded events.'), 1, 0)); fallbackNotice = true; }
        add(new Text(sanitize(text).replace(/\n+$/, ''), 1, 0));
      }
      ui.requestRender();
    },
    onSteer(handler) { steerHandler = handler; },
    itemCount: () => chat.children.filter(child => !(child instanceof Spacer)).length,
    dispose() { usageFooter.dispose(); tools.clear(); streaming.clear(); finished.clear(); users.clear(); chat.clear(); editorSlot.clear(); editor = null; parkedEditor = null; },
  };
}
