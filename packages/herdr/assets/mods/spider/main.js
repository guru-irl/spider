// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, Button } from 'gpui-base';
import { exec, run, theme, watchFolder, panes, spaces, shared, setShared, props } from 'herdr';
import { FEED_REFRESH_MS, createFeedReader, panelIpcArgv, parseSessionIpcReply } from './shared/feed.js';
import { panelSessionState, projectSpacePanel, projectNotifications, pruneDismissed, projectMemoryReview, projectSessionView, selectedSpace, notificationText, panelConfigProblem, describePanelProblems, describeFeedError, doctorCommand } from './data.js';

// Neutral chrome: colour only marks failure (danger) and needs-you (amber).
const HAIRLINE = '#2f2f32', FAINT = '#232325', RAIL = '#3a3a3d', TRACK = '#242426', HATCH = '#55555a', TODAY = '#8a8a8e', INK = '#e6e6e8', DANGER = '#ff6b6b', AMBER = '#f2c063';
const PILL = '#ffffff0d', CODE = '#ffffff12', POPOVER = '#1c1c1e', CARD_BORDER = '#38383a';
// Herdr has no robot or bell icon; spider ships them with its agents mod.
const OWN_ICONS = 'mods/spider-agents';
const PANEL_TICK_MS = 2000;

export default class SpiderPanel extends View {
  // Herdr passes {} to init; the layout's props come only from props().
  init(_props, cx) {
    const config = props();
    this.config = config; this.feeds = []; this.errors = []; this.expanded = new Set(); this.closed = false;
    // What the body shows: the home list, the Memories view, or one session's view.
    this.view = { kind: 'home' };
    this.handle = cx.focus_handle();
    // A panel without usable paths starts nothing; render() explains how to fix it.
    this.configProblem = panelConfigProblem(config);
    if (this.configProblem) return;
    this.reader = createFeedReader(config, { exec, fetch: (url, options) => fetch(url, options), timer: cx.timer });
    this.dismissKey = `spider.dismissed/${config.modId}`;
    try { const stored = shared(this.dismissKey); this.dismissed = new Set(Array.isArray(stored) ? stored.filter(token => typeof token === 'string') : []); }
    catch { this.dismissed = new Set(); }
    this.savedDismissed = JSON.stringify([...this.dismissed]);
    this.actions ||= {
      openRun: async (feed,runId) => (await this.ipc(feed,{op:'openRun',runId})).viewer,
    };
    this.timer = cx.timer.every(PANEL_TICK_MS, cx => {
      if (this.closed) return;
      // Leave one clock tick of slack before the heartbeat refresh deadline.
      const refreshDue = Date.now() - this.reloadAt >= FEED_REFRESH_MS - PANEL_TICK_MS;
      if ((this.pendingReload || refreshDue) && !this.reloading && Date.now() - this.reloadAt >= 1000) {
        this.pendingReload = false;
        cx.spawn(async next => { if (this.watchFailed) this.startWatch(next); await this.reload(next); });
      }
      // Session states, the shown space and the minute (for relative ages) decide a redraw.
      let space = null; try { space = selectedSpace(spaces())?.id ?? null; } catch { space = null; }
      const state = [...this.feeds.map(feed => panelSessionState(feed, Date.now())), space, Math.floor(Date.now() / 60000)].join(',');
      if (state !== this.clockState) { this.clockState = state; cx.notify(); }
    });
    cx.spawn(async cx => {
      await this.reload(cx);
      if (this.closed) return;
      try {
        this.startWatch(cx);
        // A second snapshot closes the gap between the first read and arming the watch.
        await this.reload(cx);

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
  async close() { this.closed = true; this.timer?.cancel(); this.watchTask?.cancel(); await this.reader?.close(); }
  /** Hide one notification occurrence; saved in Herdr's shared state so a reload keeps it hidden. */
  dismiss(item, cx) {
    for (const token of item.tokens) { this.dismissed.delete(token); this.dismissed.add(token); }
    this.saveDismissed(); cx.notify();
  }
  saveDismissed() {
    const tokens = [...this.dismissed];
    if (JSON.stringify(tokens) === this.savedDismissed) return;
    this.savedDismissed = JSON.stringify(tokens);
    try { setShared(this.dismissKey, tokens); } catch { /* A lost save only means the card returns after a reload. */ }
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
      const snapshot = await this.reader.read();
      if (this.closed) return;
      this.feeds = snapshot.feeds;
      this.errors = [...snapshot.errors.map(error => ({...error,scope:error.source === 'sessions' ? 'sessions' : 'feed',updatedAt:Date.now()})), ...this.runtimeErrors()];
      // A dismissal lapses once the state it hid is gone, so that state can return.
      this.dismissed = pruneDismissed(this.dismissed, projectNotifications(this.feeds, Date.now()));
      this.saveDismissed();
    } catch (error) { this.errors = [{ source: 'sessions', scope: 'sessions', message: String(error.message), updatedAt: Date.now() }, ...this.runtimeErrors()]; }
    finally { this.reloading = false; }
    if (!this.closed) { cx.notify(); }
  }
  /**
   * Runtime problems outlive a reload for a minute. A broken watch stays
   * visible while it is broken.
   */
  runtimeErrors() {
    const now = Date.now();
    return this.errors.filter(error => !error.scope && (now - error.updatedAt < 60000 || (error.source === 'Feed watch' && this.watchFailed)));
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
  /** Open a run's output in a Herdr viewer pane, or focus the one already shown. */
  async openRun(feed, row, cx) {
    try {
      if (row.viewer && panes().some(pane => pane.terminal === row.viewer)) { run('pane.focus', {terminal:row.viewer}); return; }
      if (panelSessionState(feed, Date.now()) !== 'live' || !feed.ipc) throw new Error('Owner endpoint unavailable');
      const viewer = await this.actions.openRun(feed, row.id);
      if (!this.closed) run('pane.focus', {terminal:viewer});
    } catch (error) { this.unavailable('Run view', error.message, cx); }
  }
  /** Run one memory review command through spider's CLI; no pi session is involved. */
  async memoryCli(args) {
    const reply = await exec(this.config.nodePath, [this.config.cliPath, 'memory', ...args]);
    let value = null; try { value = JSON.parse(String(reply.stdout).trim().split('\n').pop()); } catch { value = null; }
    if (!value || typeof value !== 'object') throw new Error(reply.stderr?.trim() || 'Spider gave no answer.');
    if (value.ok !== true) throw new Error(typeof value.message === 'string' ? value.message : 'Spider refused the request.');
    return value;
  }
  showMemories(cx) {
    this.view = { kind: 'memories' }; this.review = { loading: true, text: new Map(), decided: new Set(), busy: new Set(), failures: new Map(), error: null };
    cx.notify();
    cx.spawn(cx => this.loadReview(cx));
  }
  async loadReview(cx) {
    const review = this.review;
    try {
      const repos = [...new Set(projectMemoryReview(this.feeds).filter(row => row.scope === 'repo' && row.repoKey).map(row => row.repoKey))];
      const reply = await this.memoryCli(['pending', ...repos.flatMap(repo => ['--repo', repo])]);
      for (const item of Array.isArray(reply.items) ? reply.items : [])
        if (item && typeof item.content === 'string') review.text.set(JSON.stringify([item.scope, item.repoKey ?? null, item.uuid]), item);
    } catch (error) { review.error = error.message; }
    review.loading = false;
    if (!this.closed && this.review === review) cx.notify();
  }
  async decide(row, op, cx) {
    const review = this.review;
    if (review.busy.has(row.key)) return;
    review.busy.add(row.key); review.failures.delete(row.key); cx.notify();
    try {
      await this.memoryCli([op, '--scope', row.scope, ...(row.scope === 'repo' ? ['--repo', row.repoKey] : []), '--uuid', row.uuid]);
      review.decided.add(row.key);
    } catch (error) { review.failures.set(row.key, error.message); }
    review.busy.delete(row.key);
    if (!this.closed && this.review === review) cx.notify();
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
    if (kind === 'waiting') return div().size(14).flex_none().rounded(999).bg(amber + '26').text_size(10.5).font_bold().text_color(amber).flex().items_center().justify_center().tooltip('Needs you').child('!');
    if (kind === 'failed') return svg('mods/workspace-chrome/x.svg').size(13).flex_none().text_color(danger);
    return svg('mods/workspace-chrome/file-text.svg').size(13).flex_none().text_color(this.muted());
  }
  /** What clicking a notification card does: focus the session's pane, or open the Memories view. */
  notificationAction(item, model) {
    if (item.action === 'Review') return { enabled: true, tip: 'Review memories', act: cx => this.showMemories(cx) };
    const feed = model.sessions.find(s => s.id === item.sessionId)?.feed;
    const live = Boolean(feed) && panelSessionState(feed, Date.now()) === 'live';
    return { enabled: live, tip: live ? 'Focus the session' : 'Owner unavailable',
      act: () => { if (panelSessionState(feed, Date.now()) === 'live') run('pane.focus', { terminal: feed.owner.terminal.address }); } };
  }
  notificationRow(item, model, cx) {
    const t = theme(), action = this.notificationAction(item, model), on = Boolean(action?.enabled);
    const fire = cx => { const now = this.notificationAction(item, model); if (now?.enabled) now.act(cx); };
    const pressed = event => { const key = event?.keystroke?.key ?? event?.key; return key === 'enter' || key === 'space'; };
    // The card's body is the target; the dismiss control sits beside it, so it never runs the card's action.
    const body = h_flex().id(`need-${item.key}`).flex_1().min_w(0).py(7).pl(8).gap(10).items_center().rounded(7)
      .when(on, e => e.cursor_pointer().hover(s => s.bg(t.hover)).tab_index(0).tooltip(action.tip)
        .on_click((_event, cx) => fire(cx))
        .on_key_down((event, cx) => { if (pressed(event)) fire(cx); }))
      .child(this.glyph(item.kind))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(5).items_center().accessibility_label(notificationText(item)).children(this.parts(item)));
    const dismiss = div().id(`dismiss-${item.key}`).flex_none().mr(6).p(3).rounded(999).text_color(t.dim).cursor_pointer().tab_index(0).tooltip('Dismiss')
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => { cx.stop_propagation?.(); this.dismiss(item, cx); })
      .on_key_down((event, cx) => { if (pressed(event)) { cx.stop_propagation?.(); this.dismiss(item, cx); } })
      .child(svg('mods/workspace-chrome/x.svg').size(11));
    return h_flex().id(`card-${item.key}`).w_full().gap(4).items_center().rounded(8).border(1).border_color(CARD_BORDER).text_size(12.5)
      .child(body).child(dismiss);
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
    const link = (id, label) => h_flex().id(id).gap(4).items_center().text_size(12).text_color(t.dim)
      .cursor_pointer().hover(s => s.text_color(t.foreground)).tab_index(0).tooltip('Show todos, runs and usage')
      .on_click((_event, cx) => this.showSession(row.id, cx))
      .on_key_down((event, cx) => { const key = event?.keystroke?.key ?? event?.key; if (key === 'enter' || key === 'space') this.showSession(row.id, cx); })
      .child(label).child(svg('mods/workspace-chrome/chevron-right.svg').size(10));
    // The session's own items hang off a rail, like the sidebar's thread keylines.
    const detail = v_flex().ml(6).pl(14).mb(8).gap(6).border_l(1.5).border_color(RAIL)
      .children(row.todos.map(todo => h_flex().gap(8).items_center().min_w(0)
        .child(svg('mods/workspace-chrome/square.svg').size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().tooltip(todo.text).child(todo.text))))
      .when(row.moreTodos > 0, e => e.child(link(`more-todos-${row.id}`, `+${row.moreTodos} more`)))
      .children(row.triggers.map(trigger => h_flex().gap(8).items_center().min_w(0)
        .child(svg('mods/workspace-chrome/clock.svg').size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).child(trigger.name))
        .child(div().flex_none().font_family(mono).text_size(11.5).text_color(t.dim).child(trigger.next))))
      .children(feed.errors.map(error => this.problemLine(describeFeedError(error), `${error.source}: ${error.message}`)))
      .child(link(`view-${row.id}-todos`, 'All todos, runs and usage'));
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
  showSession(id, cx) { this.view = { kind: 'session', id }; cx.notify(); }
  showHome(cx) { this.view = { kind: 'home' }; this.review = null; cx.notify(); }
  /** A view's header: a back control and the title. */
  viewHeader(id, title, cx) {
    const t = theme();
    const back = cx => this.showHome(cx);
    return h_flex().id(`${id}-header`).w_full().pb(10).gap(8).items_center()
      .child(div().id(`${id === 'session-view' ? 'session' : id}-back`).flex_none().p(3).rounded(999).text_color(t.dim).cursor_pointer().tab_index(0).tooltip('Back')
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_event, cx) => back(cx))
        .on_key_down((event, cx) => { const key = event?.keystroke?.key ?? event?.key; if (key === 'enter' || key === 'space') back(cx); })
        .child(svg('mods/workspace-chrome/chevron-left.svg').size(12)))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_medium().text_color(t.foreground).child(title));
  }
  sectionTitle(text) { return div().w_full().pt(10).pb(4).text_size(12).font_medium().text_color(this.muted()).child(text); }
  /** Pending memories with their full text, and Approve and Reject for each. */
  memoriesView(cx) {
    const t = theme(), review = this.review ?? { loading: true, text: new Map(), decided: new Set(), busy: new Set(), failures: new Map(), error: null };
    const rows = projectMemoryReview(this.feeds).filter(row => !review.decided.has(row.key));
    const view = v_flex().id('spider-memories').w_full().gap(8).child(this.viewHeader('memories', 'Memories to review', cx));
    if (review.error) view.child(this.problemLine("Spider couldn't load the memories.", review.error, null, 'memories-error'));
    if (!rows.length) return view.child(div().id('memories-empty').text_color(t.dim).child('Nothing to review'));
    return view.children(rows.map(row => {
      const full = review.text.get(row.key), busy = review.busy.has(row.key), failure = review.failures.get(row.key);
      const text = full ? full.content : row.preview;
      return v_flex().id(`memory-${row.uuid}`).w_full().p(10).gap(8).rounded(8).border(1).border_color(CARD_BORDER)
        .child(h_flex().gap(8).items_center().text_size(11.5).text_color(this.muted())
          .child(div().flex_none().font_medium().child(row.category))
          .child(div().min_w(0).truncate().tooltip(row.scope === 'global' ? 'Global memory' : row.repoKey ?? 'Repo memory').child(row.scopeLabel)))
        .child(div().id(`memory-text-${row.uuid}`).w_full().whitespace_normal().text_size(12.5).text_color(full || review.loading ? t.foreground : t.dim)
          .tooltip(full || review.loading ? text : 'Full text unavailable; showing the preview').child(text))
        .when(Boolean(failure), e => e.child(div().id(`memory-error-${row.uuid}`).text_size(12).text_color(t.ansi1 ?? DANGER).child(failure)))
        .child(h_flex().gap(6)
          .child(this.button(`approve-${row.uuid}`, 'Approve', !busy, cx => cx.spawn(cx => this.decide(row, 'approve', cx)), 'Keep this memory'))
          .child(this.button(`reject-${row.uuid}`, 'Reject', !busy, cx => cx.spawn(cx => this.decide(row, 'reject', cx)), 'Discard this memory')));
    }));
  }
  /** The status mark of a run, by state; colour only for failure. */
  runMark(status) {
    const t = theme();
    const icon = { running: 'spinner', queued: 'clock', paused: 'clock', done: 'check', failed: 'x', cancelled: 'minus' }[status] ?? 'square';
    return svg(`mods/workspace-chrome/${icon}.svg`).size(12).flex_none().text_color(status === 'failed' ? t.ansi1 ?? DANGER : t.dim).tooltip(status);
  }
  /** One session's todos, runs and usage, from its feed. */
  sessionView(cx) {
    const t = theme(), mono = this.mono(), feed = this.feeds.find(f => f.sessionId === this.view.id);
    const view = v_flex().id('spider-session-view').w_full();
    if (!feed) return view.child(this.viewHeader('session-view', 'Session', cx)).child(div().text_color(t.dim).child('This session is gone'));
    const model = projectSessionView(feed, Date.now()), row = (id, ...children) => h_flex().id(id).w_full().py(3).gap(8).items_center().min_w(0).children(children);
    const todos = v_flex().id('session-view-todos').w_full().child(this.sectionTitle('Todos'))
      .children(model.todos.map(todo => row(`session-todo-${todo.seq}`, svg('mods/workspace-chrome/square.svg').size(12).flex_none().text_color(t.dim),
        div().flex_1().min_w(0).whitespace_normal().child(todo.text))))
      .when(!model.todos.length, e => e.child(div().py(3).text_color(t.dim).child('No open todos')))
      .when(model.done > 0, e => e.child(div().py(3).text_size(12).text_color(t.dim).child(`${model.done} done`)));
    const runs = v_flex().id('session-view-runs').w_full().child(this.sectionTitle('Runs'))
      .children(model.runs.map(item => {
        const source = feed.runs.rows.find(r => r.id === item.id);
        return row(`session-run-${item.id}`, this.runMark(item.status), div().flex_1().min_w(0).truncate().font_family(mono).child(item.name),
          div().flex_none().font_family(mono).text_size(11.5).text_color(t.dim).child(item.when))
          .rounded(6).px(4).mx(-4).cursor_pointer().hover(s => s.bg(t.hover)).tab_index(0).tooltip('Open the output')
          .on_click((_event, cx) => cx.spawn(cx => this.openRun(feed, source, cx)));
      }))
      .when(!model.runs.length, e => e.child(div().py(3).text_color(t.dim).child('No runs')))
      .when(model.moreRuns > 0, e => e.child(div().py(3).text_size(12).text_color(t.dim).child(`${model.moreRuns} older not shown`)));
    const usage = v_flex().id('session-view-usage').w_full().child(this.sectionTitle('Usage'))
      .children(model.usage.map(fact => h_flex().w_full().py(3).justify_between().items_center()
        .child(div().text_color(this.muted()).child(fact.label))
        .child(div().font_family(mono).text_color(fact.value === 'Unavailable' ? t.dim : t.foreground).child(fact.value))));
    return view.child(this.viewHeader('session-view', model.name, cx)).child(todos).child(runs).child(usage);
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
    const model = projectSpacePanel(this.feeds, space, now, { dismissed: this.dismissed ?? new Set() });
    const count = model.notifications.length, problems = describePanelProblems(this.errors);
    const home = this.view.kind === 'home';
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
        .when(this.view.kind === 'memories', e => e.child(this.memoriesView(cx)))
        .when(this.view.kind === 'session', e => e.child(this.sessionView(cx)))
        // Cards with space between them, flush with the session column.
        .when(home && count > 0, e => e.child(v_flex().id('spider-notifications').gap(6).pb(12)
          .children(model.notifications.map(item => this.notificationRow(item, model, cx)))))
        .when(home, e => e.child(v_flex().id('spider-sessions').w_full().border_t(1).border_color(HAIRLINE).pt(12)
          .child(h_flex().w_full().pb(4).items_center().text_size(12).font_medium().text_color(this.muted())
            .child(div().flex_1().child('Sessions'))
            .when(model.sessions.length > 0, e => e.child(div().w(48).text_right().tooltip('Credits used this month').child('Credits')).child(div().w(21))))
          .child(this.sessionsBody(model, problems, cx)))))
      .child(this.paceBar(model.pace, cx))
      .when(Boolean(this.paceOpen) && model.pace.state !== 'unavailable', e => e.child(this.pacePopover(model.pace)));
  }
}
