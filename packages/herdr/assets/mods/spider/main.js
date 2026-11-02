// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, Button } from 'gpui-base';
import { exec, run, theme, watchFolder, panes, spaces, shared, setShared, notify, nextCommand, hc, readTextFile, layout, props } from 'herdr';
import { parseFeed, panelIpcArgv, parseSessionIpcReply } from './shared/feed.js';
import { panelSessionState, projectSpacePanel, selectedSpace, projectMachineProblems, notificationText, panelConfigProblem, describePanelProblems, describeFeedError, doctorCommand } from './data.js';

// Neutral chrome: colour only marks failure (danger) and needs-you (amber).
const HAIRLINE = '#2f2f32', FAINT = '#232325', RAIL = '#3a3a3d', TRACK = '#242426', HATCH = '#55555a', TODAY = '#8a8a8e', INK = '#e6e6e8', DANGER = '#ff6b6b', AMBER = '#f2c063';
const PILL = '#ffffff0d', CODE = '#ffffff12', POPOVER = '#1c1c1e';
// Herdr has no robot or bell icon; spider ships them with its agents mod.
const OWN_ICONS = 'mods/spider-agents';
import { createPanelNotifications } from './notifications.js';

// This reader opens no database or terminal; Herdr has no directory-list API.
const READ_SNAPSHOT = `
const fs = require('node:fs/promises'), path = require('node:path'), {constants} = require('node:fs');
(async () => {
  const sessions = path.join(process.argv[1], 'sessions'), errors = [], stats = [], selected = [];
  const limit = 6*1024*1024, now = Date.now();
  let entries, bytes = 0, truncated = false;
  const safe = async file => { if (await fs.realpath(file) !== path.resolve(file)) throw new Error('unsafe-feed-path'); };
  const failure = (source, error) => { if (error.code !== 'ENOENT') errors.push({source,message:error.code==='ELOOP'?'unsafe-feed-path':error.code || error.message}); };
  try { await safe(process.argv[1]); await safe(sessions); entries = await fs.readdir(sessions, { withFileTypes: true }); }
  catch (error) { failure('sessions', error); entries=[]; }
  // Stat sequentially before any read: no following symlinks, and no opening special files.
  for (const entry of entries) {
    if (entry.isSymbolicLink()) { errors.push({source:entry.name,message:'unsafe-feed-path'}); continue; }
    if (!entry.isDirectory()) continue;
    const file = path.join(sessions, entry.name, 'session.json');
    try {
      await safe(file);
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error('unsafe-feed-path');
      if (stat.size > 1024*1024) throw new Error('feed-too-large');
      stats.push({file,source:entry.name,mtime:stat.mtimeMs});
    } catch (error) { failure(entry.name, error); }
  }
  stats.sort((a,b) => b.mtime-a.mtime || a.source.localeCompare(b.source));
  const order = (a,b) => a.rank-b.rank || b.mtime-a.mtime || a.source.localeCompare(b.source);
  for (const entry of stats) {
    let handle;
    try {
      await safe(entry.file);
      handle=await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat=await handle.stat();
      if (!stat.isFile()) throw new Error('unsafe-feed-path');
      if (stat.size > 1024*1024) throw new Error('feed-too-large');
      const buffer=Buffer.alloc(1024*1024+1); let offset=0;
      for (;;) { const read=await handle.read(buffer,offset,buffer.length-offset,null); offset+=read.bytesRead; if (!read.bytesRead || offset===buffer.length) break; }
      if (offset > 1024*1024) throw new Error('feed-too-large');
      await safe(entry.file);
      const text=buffer.subarray(0,offset).toString('utf8');
      let feed; try { feed=JSON.parse(text); } catch { /* The shared decoder reports invalid feeds. */ }
      const live=feed?.lifecycle==='live' && Number.isFinite(feed.updatedAt) && now-feed.updatedAt <= 10000;
      const rank=live ? 0 : now-stat.mtimeMs <= 7*86400000 ? 1 : 2;
      const size=Buffer.byteLength(JSON.stringify(text));
      selected.push({text,source:entry.source,mtime:stat.mtimeMs,rank,size}); selected.sort(order); bytes+=size;
      // Evict the lowest-priority replies, not later live entries; retained text stays bounded.
      while (bytes > limit || selected.length > 4096) { bytes-=selected.pop().size; truncated=true; }
    } catch (error) { failure(entry.source, error); }
    finally { if (handle) await handle.close(); }
  }
  if (truncated) errors.push({source:'sessions',message:'Snapshot truncated: feed total exceeds reply limit'});
  console.log(JSON.stringify({feeds:selected.map(entry=>entry.text),sources:selected.map(entry=>entry.source),errors}));
})().catch(() => { process.exitCode=1; });
`;

export default class SpiderPanel extends View {
  // Herdr passes {} to init; the layout's props come only from props().
  init(_props, cx) {
    const config = props();
    this.config = config; this.feeds = []; this.errors = []; this.expanded = new Set(); this.closed = false;
    this.handle = cx.focus_handle();
    // A panel without usable paths starts nothing; render() explains how to fix it.
    this.configProblem = panelConfigProblem(config);
    if (this.configProblem) return;
    this.actions ||= {
      ping: async feed => { try { await this.ipc(feed,{op:'ping'}); return true; } catch { return false; } },
      openView: async (feed,view) => { await this.ipc(feed,{op:'openView',view}); },
      openRun: async (feed,runId) => (await this.ipc(feed,{op:'openRun',runId})).viewer,
    };
    try {
      this.notifier = createPanelNotifications(config.modId, {
        read: shared, write: setShared, feeds: () => this.feeds, clock: () => Date.now(), post: notify,
        schedule: work => { cx.spawn(async cx => { try { await work(); } catch (error) { this.unavailable('Notifications',error.message,cx); } }); },
        ping: feed => this.actions.ping(feed), openUsage: async feed => { await this.actions.openView(feed,'usage'); },
        focus: async address => { run('pane.focus',{terminal:address}); },
      });
    } catch (error) { this.errors.push({source:'Notification setup',message:error.message,updatedAt:Date.now()}); }
    this.timer = cx.timer.every(2000, cx => {
      if (this.closed) return;
      // Machine connections change rarely: every fifth tick, on the same timer.
      this.ticks = (this.ticks ?? 0) + 1;
      if (this.ticks % 5 === 0 && this.isVisible()) cx.spawn(next => this.refreshMachines(next));
      const fallback = this.watchFailed && Date.now() - this.reloadAt >= 8000;
      if ((this.pendingReload || fallback) && !this.reloading && Date.now() - this.reloadAt >= 1000) {
        this.pendingReload = false;
        cx.spawn(async next => { if (fallback) this.startWatch(next); await this.reload(next); });
      }
      // Session states, the shown space and the minute (for relative ages) decide a redraw.
      let space = null; try { space = selectedSpace(spaces())?.id ?? null; } catch { space = null; }
      const state = [...this.feeds.map(feed => panelSessionState(feed, Date.now())), space, Math.floor(Date.now() / 60000)].join(',');
      if (state !== this.clockState) { this.clockState = state; cx.notify(); }
    });
    cx.spawn(async cx => {
      await this.reload(cx);
      if (this.closed) return;
      await this.refreshMachines(cx);
      try {
        this.startWatch(cx);
        // A second snapshot closes the gap between the first read and arming the watch.
        await this.reload(cx);
        if (this.notifier) this.commandTask = cx.spawn(async cx => {
          try {
            while (!this.closed) {
              const command = await nextCommand(); if (this.closed) break;
              const reply = await this.notifier.command(command);
              if (!reply.ok && command.startsWith('notice-')) this.unavailable('Notification action',reply.reason,cx);
            }
          } catch (error) { this.unavailable('Notification commands',error.message,cx); }
        });
      } catch (error) { this.unavailable('Feed watch', error.message, cx); }
    });
  }
  startWatch(cx) {
    if (this.closed || this.watching) return;
    this.watching = true; this.watchFailed = false;
    this.watchTask = cx.spawn(async cx => {
      try {
        let next = watchFolder(this.config.feedRoot + '/sessions'); next.catch(() => {});
        while (!this.closed) {
          await next; if (this.closed) break;
          next = watchFolder(this.config.feedRoot + '/sessions'); next.catch(() => {});
          if (Date.now() - this.reloadAt >= 1000 && !this.reloading) await this.reload(cx);
          else this.pendingReload = true;
        }
      } catch (error) { this.watchFailed = true; this.unavailable('Feed watch', error.message, cx); }
      finally { this.watching = false; }
    });
  }
  close() { this.closed = true; this.notifier?.close(); this.timer?.cancel(); this.watchTask?.cancel(); this.commandTask?.cancel(); }
  isVisible() {
    try {
      const root = layout(); if (!root) return true;
      const visit = (node, shown) => {
        if (!node || typeof node !== 'object') return false;
        const visible = shown && !node.hidden;
        if (node.content?.mod === this.config.modId) return visible;
        return (node.children ?? []).some(child => visit(child, visible && (node.type !== 'stack' || !node.active || node.active === child.id)));
      };
      return visit(root, true);
    } catch { return true; }
  }
  /** Configured machines against Herdr's connection list; persistent problems become notification items. */
  async refreshMachines(cx) {
    if (this.closed || this.machineRefreshing || !this.isVisible()) return;
    this.machineRefreshing = true;
    let problems = [];
    try {
      // Installed props are authoritative; older copies may lack them.
      const configured = Array.isArray(this.config.machines) ? this.config.machines : JSON.parse(await readTextFile(this.config.configPath) ?? 'null')?.machines;
      if (Array.isArray(configured) && configured.length) {
        const reply = await hc(['machine', 'ls', '--json']);
        const inventory = reply.code === 0 ? JSON.parse(reply.stdout).machines : null;
        // No connection list at all: every configured machine is unreachable.
        problems = projectMachineProblems(configured, Array.isArray(inventory) ? inventory : []);
      }
    } catch { problems = []; }
    finally { this.machineRefreshing = false; }
    if (this.closed) return;
    const now = Date.now(), candidates = new Map(), previous = this.machineCandidates ?? new Map();
    problems = problems.filter(item => {
      const key = notificationText(item), prior = previous.get(item.key);
      const since = prior?.key === key && now >= prior.since ? prior.since : now;
      candidates.set(item.key, { key, since });
      return now - since >= 10000;
    });
    this.machineCandidates = candidates;
    const key = problems.map(item => notificationText(item)).join('|');
    if (key !== this.machineKey) { this.machineKey = key; this.machineProblems = problems; cx.notify(); }
  }
  unavailable(source, message, cx, command = null) {
    if (this.closed) return;
    this.errors.push({source,message,command,updatedAt:Date.now()}); cx.notify();
  }
  async reload(cx) {
    if (this.closed) return;
    if (this.reloading) { this.pendingReload = true; return; }
    this.reloading = true; this.pendingReload = false; this.reloadAt = Date.now();
    try {
      const reply = await exec(this.config.nodePath, ['-e', READ_SNAPSHOT, this.config.feedRoot]);
      if (reply.code !== 0) throw new Error('Feed read failed');
      const snapshot = JSON.parse(reply.stdout);
      if (!snapshot || !Array.isArray(snapshot.feeds) || !snapshot.feeds.every(text => typeof text === 'string') || !Array.isArray(snapshot.errors)) throw new Error('Invalid feed snapshot');
      if (this.closed) return;
      this.feeds = []; this.errors = [...snapshot.errors.map(error => ({...error,scope:error.source === 'sessions' ? 'sessions' : 'feed',updatedAt:Date.now()})), ...this.runtimeErrors()];
      for (const [index, text] of snapshot.feeds.entries()) {
        const feed = parseFeed(text);
        if (feed) this.feeds.push(feed);
        else this.errors.push({ source: typeof snapshot.sources?.[index] === 'string' ? snapshot.sources[index] : 'session feed', scope: 'feed', message: 'Unavailable: invalid feed', updatedAt: Date.now() });
      }
    } catch (error) { this.errors = [{ source: 'sessions', scope: 'sessions', message: String(error.message), updatedAt: Date.now() }, ...this.runtimeErrors()]; }
    finally { this.reloading = false; }
    if (!this.closed) { this.notifier?.update(this.feeds,Date.now()); cx.notify(); }
  }
  /**
   * Runtime problems outlive a reload for a minute; a broken watch or notice
   * setup stays while it is broken.
   */
  runtimeErrors() {
    const now = Date.now();
    return this.errors.filter(error => !error.scope && (now - error.updatedAt < 60000 || error.source === 'Notification setup' || (error.source === 'Feed watch' && this.watchFailed)));
  }
  async ipc(feed, request) {
    if (!feed.ipc || panelSessionState(feed, Date.now()) !== 'live') throw new Error('Owner endpoint unavailable');
    const descriptor = {version:1,sessionId:feed.sessionId,generation:feed.generation,...feed.ipc};
    const [command, ...args] = panelIpcArgv(this.config.nodePath,this.config.cliPath,descriptor,{...request,generation:feed.generation});
    const result = await exec(command,args), reply = parseSessionIpcReply(result.stdout);
    if (!reply) throw new Error('Invalid IPC reply');
    if (!reply.ok) throw new Error(reply.message);
    if (result.code !== 0) throw new Error('IPC action failed');
    if (reply.op !== request.op) throw new Error('Unexpected IPC acknowledgement');
    return reply;
  }
  async doctor(cx) {
    try {
      const reply = await exec(this.config.nodePath, [this.config.cliPath, 'doctor', '--config', this.config.configPath]);
      if (!this.closed) { this.diagnostic = (reply.code === 0 ? reply.stdout : reply.stderr || reply.stdout).slice(0,10000); cx.notify(); }
    } catch (error) { this.unavailable('Doctor', error.message, cx, doctorCommand(this.config)); }
  }
  approvalEndpoints(row) {
    return this.feeds.filter(feed => panelSessionState(feed, Date.now()) === 'live' && feed.ipc && (row.scope === 'global' || feed.approvals.some(a => a.scope === row.scope && a.repoKey === row.repoKey && a.uuid === row.uuid)));
  }
  async openSharedMemory(row, cx) {
    try {
      for (const feed of this.approvalEndpoints(row)) {
        let verified = false; try { verified = await this.actions.ping(feed); } catch { continue; }
        if (!verified) continue;
        await this.openView(feed, 'memory', cx); return;
      }
      throw new Error('No live approval endpoint');
    } catch (error) { this.unavailable('Shared approvals', error.message, cx); }
  }
  async openRun(feed, row, cx) {
    try {
      if (panelSessionState(feed, Date.now()) !== 'live') throw new Error('Owner unavailable');
      if (row.viewer && panes().some(pane => pane.terminal === row.viewer)) { run('pane.focus', {terminal:row.viewer}); return; }
      if (!feed.ipc || !this.actions || !await this.actions.ping(feed)) throw new Error('Owner endpoint unavailable');
      const viewer = await this.actions.openRun(feed, row.id);
      if (!this.closed && panelSessionState(feed, Date.now()) === 'live') run('pane.focus', {terminal:viewer});
    } catch (error) { this.unavailable('Run view', error.message, cx); }
  }
  async openJob(feed, jobId, cx) {
    try {
      if (panelSessionState(feed, Date.now()) !== 'live' || !feed.ipc || !this.actions || !await this.actions.ping(feed)) throw new Error('Owner endpoint unavailable');
      if (this.closed) return;
      const reply = await this.ipc(feed, { op: 'openJob', jobId });
      if (!this.closed && panelSessionState(feed, Date.now()) === 'live') run('pane.focus', { terminal: reply.viewer });
    } catch (error) { this.unavailable('Job output', error.message, cx); }
  }
  async openView(feed, view, cx) {
    try {
      if (panelSessionState(feed, Date.now()) !== 'live' || !feed.ipc || !this.actions || !await this.actions.ping(feed)) throw new Error('Owner endpoint unavailable');
      if (this.closed) return;
      await this.actions.openView(feed, view);
    } catch (error) { this.unavailable('View action', error.message, cx); }
  }
  mono() { return this.config?.fonts?.paths ?? 'JetBrains Mono'; }
  muted() { const t = theme(); return t.muted ?? t.dim; }
  button(id, label, enabled, action, reason = '') {
    const t = theme();
    return Button.new(id).child(label).px(10).py(2).rounded(999).border(1).border_color(HAIRLINE).disabled(!enabled).tooltip(reason || label)
      .bg('#00000000').text_size(11.5).text_color(enabled ? t.foreground : t.dim).hover(s => s.bg(t.hover))
      .on_click((_event, cx) => { if (enabled) action(cx); });
  }
  /**
   * Agents and machines get a slim pill (small icon, monospace name, a faint
   * fill); a command reads like markdown inline code.
   */
  pill(part, id) {
    if (part.type === 'command') return div().id(id).flex_none().min_w(0).max_w(200).px(4).rounded(4).bg(CODE)
      .font_family(this.mono()).text_size(11.5).text_color(theme().foreground).truncate().tooltip(part.text).child(part.text);
    const icon = part.type === 'agent' ? (part.icon === 'subagent' ? `${OWN_ICONS}/bot.svg` : 'mods/workspace-chrome/terminal.svg') : 'mods/workspace-chrome/server.svg';
    return h_flex().id(id).h(16).px(5).gap(3).flex_none().min_w(0).max_w(170).items_center().rounded(999).bg(PILL)
      .font_family(this.mono()).text_size(10.5).text_color(this.muted()).tooltip(part.text)
      .child(svg(icon).size(10).flex_none())
      .child(div().min_w(0).truncate().child(part.text));
  }
  // Plain phrases with word spacing: "[agent] `command` failed on [machine]".
  parts(item) {
    const t = theme();
    return item.parts.map((part, index) => part.type === 'text' ? div().flex_none().text_color(t.foreground).child(part.text)
      : part.type === 'detail' ? div().min_w(0).truncate().text_color(t.dim).tooltip(part.text).child(part.text)
      : this.pill(part, `pill-${item.key}-${index}`));
  }
  /** The leading mark of a notification item, by kind. */
  glyph(kind) {
    const t = theme(), danger = t.ansi1 ?? DANGER, amber = t.blocked ?? AMBER;
    const badge = (color, tip) => div().size(14).flex_none().rounded(999).bg(color + '26').text_size(10.5).font_bold().text_color(color).flex().items_center().justify_center().tooltip(tip).child('!');
    if (kind === 'waiting') return badge(amber, 'Needs you');
    if (kind === 'machine') return badge(amber, 'Machine problem');
    if (kind === 'failed') return svg('mods/workspace-chrome/x.svg').size(13).flex_none().text_color(danger);
    if (kind === 'memory') return svg('mods/workspace-chrome/file-text.svg').size(13).flex_none().text_color(this.muted());
    return badge(danger, 'Over pace');
  }
  /** What clicking a notification row does: the same action the old buttons ran. */
  notificationAction(item, model) {
    const feed = item.sessionId ? model.sessions.find(s => s.id === item.sessionId)?.feed : null;
    const live = Boolean(feed) && panelSessionState(feed, Date.now()) === 'live';
    if (item.action === 'Focus') return { enabled: live, tip: live ? 'Focus the session' : 'Owner unavailable',
      act: () => { if (panelSessionState(feed, Date.now()) === 'live') run('pane.focus', { terminal: feed.owner.terminal.address }); } };
    if (item.action === 'Output' && item.jobId) {
      const shown = item.address && panes().some(pane => pane.terminal === item.address);
      return { enabled: Boolean(shown || (live && feed.ipc && this.actions)), tip: shown || live ? 'Show the command output' : 'Owner unavailable',
        act: cx => shown ? run('pane.focus', { terminal: item.address }) : cx.spawn(cx => this.openJob(feed, item.jobId, cx)) };
    }
    if (item.action === 'Output') {
      const row = feed?.runs.rows.find(r => r.id === item.runId);
      return { enabled: Boolean(live && row), tip: live ? 'Open the run output' : 'Owner unavailable', act: cx => cx.spawn(cx => this.openRun(feed, row, cx)) };
    }
    if (item.action === 'Review') {
      const approval = item.approvals[0];
      return { enabled: Boolean(this.actions && this.approvalEndpoints(approval).length), tip: 'Open memory review', act: cx => cx.spawn(cx => this.openSharedMemory(approval, cx)) };
    }
    if (item.action === 'Usage') {
      const target = this.feeds.find(f => panelSessionState(f, Date.now()) === 'live' && f.ipc);
      return { enabled: Boolean(target && this.actions), tip: 'Open usage', act: cx => cx.spawn(cx => this.openView(target, 'usage', cx)) };
    }
    return null;
  }
  notificationRow(item, model, cx) {
    const t = theme(), action = this.notificationAction(item, model), on = Boolean(action?.enabled);
    const fire = cx => { const now = this.notificationAction(item, model); if (now?.enabled) now.act(cx); };
    // The whole row is the target: a hover fill, a tab stop, and Enter or Space.
    return h_flex().id(`need-${item.key}`).w_full().py(7).px(8).gap(10).items_center().rounded(8).text_size(12.5)
      .when(on, e => e.cursor_pointer().hover(s => s.bg(t.hover)).tab_index(0).tooltip(action.tip)
        .on_click((_event, cx) => fire(cx))
        .on_key_down((event, cx) => { const key = event?.keystroke?.key ?? event?.key; if (key === 'enter' || key === 'space') fire(cx); }))
      .child(this.glyph(item.kind))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(5).items_center().accessibility_label(notificationText(item)).children(this.parts(item)));
  }
  sessionRow(row, cx) {
    const t = theme(), feed = row.feed, mono = this.mono(), state = panelSessionState(feed, Date.now()), expanded = this.expanded.has(row.id);
    const toggle = cx => { expanded ? this.expanded.delete(row.id) : this.expanded.add(row.id); cx.notify(); };
    const FACT_ICONS = { live: `${OWN_ICONS}/bot.svg`, todos: 'mods/workspace-chrome/square.svg' };
    // The kind icon leads the row; status lives in the left sidebar. Clicking the icon focuses the session.
    const head = h_flex().id(`session-head-${row.id}`).w_full().py(8).gap(10).items_center().cursor_pointer().on_click((_event, cx) => toggle(cx))
      .child(div().id(`focus-${row.id}`).flex_none().p(2).m(-2).rounded(999).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(state === 'live' ? 'Focus the session' : `${state}: owner unavailable`)
        .on_click((_event, cx) => { cx.stop_propagation?.(); if (panelSessionState(feed, Date.now()) === 'live') run('pane.focus', { terminal: feed.owner.terminal.address }); })
        .child(svg('mods/workspace-chrome/terminal.svg').size(13)))
      .child(div().flex_1().min_w(0).truncate().font_family(mono).text_color(state === 'live' ? t.foreground : t.dim).tooltip(state === 'live' ? row.name : `${row.name}: ${state}`).child(row.name))
      .child(h_flex().id(`facts-${row.id}`).flex_none().gap(8).items_center().font_family(mono).text_size(11).text_color(t.dim)
        .children(row.facts.map(fact => h_flex().gap(3).items_center().tooltip(fact.label)
          .child(svg(FACT_ICONS[fact.kind]).size(11).flex_none()).child(String(fact.count)))))
      // Credits this month, labelled by the usage dashboard: a right-aligned monospace column.
      .child(div().id(`cost-${row.id}`).flex_none().w(48).text_right().font_family(mono).text_size(12)
        .text_color(row.cost === null || row.cost === 'unavailable' ? t.dim : t.foreground)
        .tooltip(row.cost === null ? 'Credits this month unavailable' : 'Credits this month').child(row.cost ?? '\u2013'))
      .child(svg(`mods/workspace-chrome/chevron-${expanded ? 'down' : 'right'}.svg`).size(11).flex_none().text_color(t.dim));
    const viewEnabled = state === 'live' && Boolean(feed.ipc && this.actions);
    const link = (id, label, view) => h_flex().id(id).gap(4).items_center().text_size(12).text_color(viewEnabled ? t.dim : t.unknown ?? t.dim)
      .when(viewEnabled, e => e.cursor_pointer().hover(s => s.text_color(t.foreground)))
      .tooltip(viewEnabled ? 'Open the full views' : state !== 'live' ? `${state}: owner unavailable` : 'Owner endpoint unavailable')
      .on_click((_event, cx) => { if (viewEnabled) cx.spawn(cx => this.openView(feed, view, cx)); })
      .child(label).child(svg('mods/workspace-chrome/chevron-right.svg').size(10));
    // The session's own items hang off a rail, like the sidebar's thread keylines.
    const detail = v_flex().ml(6).pl(14).mb(8).gap(6).border_l(1.5).border_color(RAIL)
      .children(row.todos.map(todo => h_flex().gap(8).items_center().min_w(0)
        .child(svg('mods/workspace-chrome/square.svg').size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().tooltip(todo.text).child(todo.text))))
      .when(row.moreTodos > 0, e => e.child(link(`more-todos-${row.id}`, `+${row.moreTodos} more`, 'todos')))
      .children(row.triggers.map(trigger => h_flex().gap(8).items_center().min_w(0)
        .child(svg('mods/workspace-chrome/clock.svg').size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).child(trigger.name))
        .child(div().flex_none().font_family(mono).text_size(11.5).text_color(t.dim).child(trigger.next))))
      .children(feed.errors.map(error => this.problemLine(describeFeedError(error), `${error.source}: ${error.message}`)))
      .child(link(`view-${row.id}-todos`, 'All todos, runs and usage', 'todos'));
    return v_flex().id(`session-${row.id}`).w_full().child(head).when(expanded, e => e.child(detail));
  }
  /** The month's credits as a slim pace track pinned to the panel's bottom edge. */
  paceBar(pace, cx) {
    const t = theme(), mono = this.mono(), danger = t.ansi1 ?? DANGER;
    const footer = h_flex().id('spider-pace').flex_none().w_full().h(40).px(16).gap(10).items_center().border_t(1).border_color(HAIRLINE);
    if (pace.state === 'unavailable') return footer.child(div().text_size(12).text_color(t.dim).tooltip(pace.reason).child('Usage unavailable'));
    const pct = f => `${(f * 100).toFixed(2)}%`, scaled = pace.state === 'ok', ink = scaled && pace.over ? danger : INK;
    const month = (pace.labels.month ?? 'Month').split(' ')[0];
    const track = div().id('pace-track').relative().flex_1().h(6).rounded(999).bg(TRACK)
      .when(scaled && pace.projectedFraction !== null && pace.projectedFraction > pace.usedFraction, e => e.child(
        h_flex().id('pace-projection').absolute().top(0).bottom(0).left(pct(pace.usedFraction)).w(pct(pace.projectedFraction - pace.usedFraction)).gap(3).overflow_hidden()
          .children(Array.from({ length: 80 }, () => div().w(1.5).h_full().flex_none().bg(scaled && pace.over ? danger : HATCH)))))
      .when(scaled, e => e.child(div().id('pace-used').absolute().top(0).bottom(0).left(0).w(pct(pace.usedFraction)).rounded(999).bg(ink)))
      .when(scaled && pace.todayFraction !== null, e => e.child(div().id('pace-today').absolute().top(-2).bottom(-2).left(pct(pace.todayFraction)).w(1.5).bg(TODAY)))
      // The dashboard's ring at the current point, drawn over the slim track.
      .when(scaled, e => e.child(div().id('pace-now').absolute().top(-3).left(pct(pace.usedFraction)).ml(-6).size(12).rounded(999).border(2).border_color(ink).bg('#161618')));
    return footer.cursor_pointer()
      .on_hover((hovered, cx) => { if (this.paceOpen !== hovered) { this.paceOpen = hovered; cx.notify(); } })
      .child(div().flex_none().font_family(mono).text_size(11).text_color(t.dim).child(month))
      .child(track)
      .child(div().id('pace-amount').flex_none().font_family(mono).text_size(12).text_color(scaled && pace.over ? danger : t.foreground).child(pace.labels.usedCompact));
  }
  /** Hover details, as the dashboard's pace popover: exact values, the month, freshness and the pace state. */
  pacePopover(pace) {
    const t = theme(), mono = this.mono(), danger = t.ansi1 ?? DANGER;
    const row = (label, value) => h_flex().w_full().py(4).justify_between().items_center()
      .child(div().text_size(12).text_color(this.muted()).child(label))
      .child(div().font_family(mono).text_size(12).text_color(value === 'unavailable' ? t.dim : t.foreground).child(value));
    const scaled = pace.state === 'ok';
    return v_flex().id('pace-popover').absolute().bottom(46).left(12).right(12).p(14).gap(2).rounded(12).border(1).border_color(HAIRLINE).bg(POPOVER)
      .child(div().mb(6).font_family(mono).text_size(13).font_semibold().text_color(t.foreground).child(pace.labels.month ?? 'This month'))
      .child(row('Used', pace.labels.used))
      .when(scaled, e => e.child(row('Projected month end', pace.labels.projected)).child(row('Budget', pace.labels.budget)).child(row('Remaining', pace.labels.remaining)))
      .child(div().mt(8).text_size(12).text_color(scaled && pace.over ? danger : this.muted())
        .child(!scaled ? 'No budget set, so no pace' : pace.over ? 'Over pace for the budget' : 'On pace for the budget'))
      .when(Boolean(pace.labels.updatedAt || pace.updated), e => e.child(div().text_size(11.5).text_color(t.dim)
        .child(`Updated ${pace.labels.updatedAt ?? pace.updated}${pace.labels.updatedAt && pace.updated ? ` (${pace.updated})` : ''}`)));
  }
  /** One problem: a red mark and a plain sentence; the technical reason is the tooltip. */
  problemLine(text, tip, command = null, id = null) {
    const t = theme(), danger = t.ansi1 ?? DANGER;
    return h_flex().when(Boolean(id), e => e.id(id)).w_full().gap(8).items_start().text_size(12.5).tooltip(tip || text)
      .child(svg('mods/workspace-chrome/x.svg').mt(3).size(11).flex_none().text_color(danger))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(5).items_center()
        .child(div().text_color(t.foreground).child(text))
        .when(Boolean(command), e => e.child(this.pill({ type: 'command', text: command }, `${id ?? 'problem'}-command`))));
  }
  /** Runtime problems in one compact group: merged, capped, with a toggle for the rest. */
  problemsGroup(problems) {
    const t = theme(), rows = this.problemsOpen ? problems.all : problems.rows;
    return v_flex().id('spider-problems').w_full().gap(6).pb(12)
      .children(rows.map((row, index) => this.problemLine(row.text, row.tip, row.command, `problem-${index}`)))
      .when(problems.all.length > problems.rows.length, e => e.child(div().id('spider-problems-more').ml(19).text_size(12).text_color(t.dim).cursor_pointer()
        .hover(s => s.text_color(t.foreground)).tab_index(0)
        .on_click((_event, cx) => { this.problemsOpen = !this.problemsOpen; cx.notify(); })
        .child(this.problemsOpen ? 'Show fewer' : `+${problems.more} more`)));
  }
  /** The whole panel when it cannot start: what is wrong, the fix, and the technical reason. */
  configState(problem) {
    const t = theme(), danger = t.ansi1 ?? DANGER;
    return v_flex().id('spider-config').w_full().pt(24).gap(10)
      .child(div().size(28).rounded(999).bg(danger + '1f').flex().items_center().justify_center()
        .child(svg('mods/workspace-chrome/x.svg').size(14).text_color(danger)))
      .child(div().text_size(14).font_medium().text_color(t.foreground).child(problem.title))
      .child(div().text_size(12.5).text_color(t.foreground).child(problem.text))
      .child(h_flex().id('spider-config-fix').w_full().flex_wrap().gap(5).items_center().text_size(12.5)
        .children(problem.fix.map((part, index) => part.type === 'command' ? this.pill(part, `config-fix-${index}`) : div().text_color(t.foreground).child(part.text))))
      .child(div().mt(-4).text_size(12.5).text_color(t.foreground).child(problem.then))
      // The technical reason, for doctor output and bug reports.
      .child(div().font_family(this.mono()).text_size(11).text_color(this.muted()).child(problem.detail));
  }
  /** The Sessions list, or why it is empty; never "No live sessions" when the feeds could not be read. */
  sessionsBody(model, problems, cx) {
    const t = theme(), doctor = () => h_flex().child(this.button('spider-doctor', 'Run doctor', true, cx => cx.spawn(cx => this.doctor(cx)), 'Check the installation and the session feeds'));
    const rows = model.sessions.length
      ? v_flex().w_full().children(model.sessions.map((row, index) => { const item = this.sessionRow(row, cx); return index ? item.border_t(1).border_color(FAINT) : item; }))
      : null;
    if (problems.sessions) return v_flex().w_full().gap(6)
      .child(v_flex().id('spider-sessions-unread').gap(2)
        .child(div().text_size(12.5).text_color(t.foreground).child("Spider couldn't read the session feeds, so sessions may be missing here."))
        .child(div().text_size(11.5).text_color(this.muted()).child(problems.sessions.detail)))
      .when(Boolean(rows), e => e.child(rows)).when(!rows, e => e.child(doctor()));
    if (rows) return rows;
    if (this.feeds.length) return div().text_color(t.dim).child('No sessions in this space');
    const skipped = problems.all.some(row => row.key.startsWith('feed:') && row.key !== 'feed:truncated');
    return v_flex().gap(6).child(div().text_color(t.dim).child(skipped ? "Spider couldn't read any session feed." : 'No live sessions')).child(doctor());
  }
  render(cx) {
    const t = theme(), now = Date.now(), mono = this.mono();
    const close = div().id('panel-close').p(4).rounded(999).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip('Close panel')
      .on_click(() => run('layout.hide', { id: 'panel' })).child(svg('mods/workspace-chrome/x.svg').size(14));
    const root = v_flex().id('spider').relative().size_full().min_h(0).overflow_hidden().bg('#161618f0').text_color(t.foreground).text_size(13).track_focus(this.handle);
    // Nothing else can work without the layout's paths: no bell, sessions, doctor or usage.
    if (this.configProblem) return root
      .child(h_flex().h(40).flex_none().px(16).items_center().child(div().flex_1()).child(close))
      .child(v_flex().id('spider-scroll').flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(12).child(this.configState(this.configProblem)));
    let space = null; try { space = selectedSpace(spaces()); } catch { space = null; }
    const model = projectSpacePanel(this.feeds, space, now, { machines: this.machineProblems ?? [] });
    const count = model.notifications.length, problems = describePanelProblems(this.errors);
    return root
      .child(h_flex().h(40).flex_none().px(16).gap(6).items_center()
        // A bell and its count instead of a title; no space name (the sidebar shows it).
        .child(h_flex().id('spider-bell').gap(6).items_center().text_color(count ? t.foreground : t.dim).tooltip(count ? `${count} to act on` : 'Nothing to act on')
          .child(svg(`${OWN_ICONS}/bell.svg`).size(14).flex_none())
          .when(count > 0, e => e.child(div().id('spider-bell-count').font_family(mono).text_size(12).child(String(count)))))
        .child(div().flex_1())
        .child(close))
      .child(v_flex().id('spider-scroll').flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(12)
        .when(problems.all.length > 0, e => e.child(this.problemsGroup(problems)))
        .when(Boolean(this.diagnostic), e => e.child(div().pb(6).font_family(mono).text_size(11).tooltip(this.diagnostic).child(this.diagnostic)))
        // Rows carry their own padding for the hover fill; the list sits flush with the session column.
        .when(count > 0, e => e.child(v_flex().id('spider-notifications').mx(-8).gap(2).pb(8)
          .children(model.notifications.map(item => this.notificationRow(item, model, cx)))))
        .child(v_flex().id('spider-sessions').w_full().border_t(1).border_color(HAIRLINE).pt(12)
          .child(h_flex().w_full().pb(4).items_center().text_size(12).font_medium().text_color(this.muted())
            .child(div().flex_1().child('Sessions'))
            .when(model.sessions.length > 0, e => e.child(div().w(48).text_right().tooltip('Credits used this month').child('Credits')).child(div().w(21))))
          .child(this.sessionsBody(model, problems, cx))))
      .child(this.paceBar(model.pace, cx))
      .when(Boolean(this.paceOpen) && model.pace.state !== 'unavailable', e => e.child(this.pacePopover(model.pace)));
  }
}
