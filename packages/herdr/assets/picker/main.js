// SPDX-License-Identifier: Apache-2.0
// Derived from Herdr's picker. See NOTICE for upstream provenance.
import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import * as herdr from 'herdr';
import { pickerRows, selectPickerRow } from './model.js';
import { indexPaneNavigation, projectNavigation } from '../shared/navigation.js';
import { describeOpenFailure } from '../shared/open-failure.js';
import { assignSpaceIdentities } from '../shared/look.js';
import { FEED_REFRESH_MS, createFeedReader, panelIpcArgv, parseSessionIpcReply, requestPaneService } from '../shared/feed.js';

const BG = '#161618fe', SELECTED = '#ffffff14', HOVER = '#ffffff12', FAINT = '#ffffff0d';
const absolute = value => typeof value === 'string' && (/^\//.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) && !value.includes('\0');
function validConfig(value) {
  const contract = value?.labelContract, labels = contract?.labels, kinds = contract?.kinds;
  return value && typeof value === 'object' && [value.feedRoot, value.nodePath, value.cliPath].every(absolute)
    && contract?.version === 1 && labels && kinds
    && ['session', 'ownerCore', 'ownerTerminal', 'kind', 'job', 'run', 'space', 'tab', 'machine', 'parentName', 'steer', 'displayName', 'viewerLifetime'].every(key => typeof labels[key] === 'string' && labels[key])
    && ['exec', 'execFile', 'batch', 'remoteObserver', 'subagentViewer', 'setupProbe', 'session', 'remoteConsole'].every(key => typeof kinds[key] === 'string' && kinds[key]);
}
function nativeTargets(agents, terminals, panes) {
  const known = new Map(terminals.map(item => [item.address, item]));
  return agents.flatMap(agent => {
    const terminal = known.get(agent.address), name = terminal?.labels?.['spider.display-name'];
    if (typeof name !== 'string' || !name.trim()) return [];
    const pane = panes.find(item => item.terminal === agent.address)?.pane ?? agent.pane ?? null;
    return [{ id: `agent:${agent.address}`, kind: 'agent', ownerId: null, sessionId: null, terminal: agent.address, pane,
      space: agent.space ?? null, tab: agent.tab ?? null, name,
      path: null, status: agent.status ?? 'idle', machine: agent.address.includes('/') ? agent.address.split('/')[0] : null,
      retained: false, action: pane && !pane.includes('/') && !agent.address.includes('/') ? { kind: 'focus', pane } : null }];
  });
}

export class Picker extends View {
  init(_props, cx) {
    this.cx = cx; this.handle = cx.focus_handle(); this.closed = false; this.filter = ''; this.selectedId = null; this.scroll = 0;
    const focus = herdr.focused?.();
    this.returnFocus = focus?.space && focus?.tab && focus?.pane ? { space: focus.space, tab: focus.tab, pane: focus.pane } : null;
    this.paneSnapshot = null; this.feeds = []; this.targetSource = 'pending'; this.coreId = ''; this.machineIds = new Map(); this.identityAt = null; this.pending = new Set(); this.problem = null;
    const props = herdr.props() ?? {}; this.overlay = props.overlay; this.config = validConfig(props) ? props : null;
    this.input = InputState.new({ placeholder: 'Go to a space, tab, or agent' });
    this.input.on('change', (_event, current) => { this.filter = this.input.value(); this.selectedId = selectPickerRow(this.rows(), null, 0); current.notify(); });
    this.input.on('submit', () => { void this.activate(this.selectedId); });
    if (herdr.checking?.()) { this.targetSource = 'native'; this.ready = Promise.resolve(); return; }
    this.input.focus();
    this.ready = new Promise(resolve => {
      cx.spawn(async current => {
        try {
          if (!this.config) {
            try {
              const content = await herdr.readTextFile(`${herdr.appHome()}/mods/spider-picker/config.json`);
              const config = content ? JSON.parse(content) : null;
              if (config?.version === 1 && validConfig(config)) this.config = config;
            } catch { /* Native rows remain available without installed config. */ }
          }
          if (this.closed) return;
          if (this.config) {
            this.reader = createFeedReader(this.config, { exec: herdr.exec, fetch: (url, options) => fetch(url, options), timer: current.timer });
            await this.refresh();
            if (this.closed) return;
            this.startWatch(current);
            this.timer = current.timer.every(FEED_REFRESH_MS, next => { if (!this.closed) next.spawn(async () => this.refresh()); });
          } else this.targetSource = 'native';
          this.startCommands(current);
        } finally { resolve(); current.notify(); }
      });
    });
  }
  startWatch(cx) {
    if (this.closed || !this.config) return;
    this.watchTask = cx.spawn(async () => {
      try {
        while (!this.closed) {
          this.watch?.cancel?.();
          const watch = herdr.watchFolder(`${this.config.feedRoot}/sessions`); this.watch = watch;
          await watch; watch.cancel?.(); if (this.watch === watch) this.watch = null;
          if (!this.closed) await this.refresh();
        }
      } catch { /* The periodic refresh remains available if a watch fails. */ }
    });
  }
  startCommands(cx) {
    this.commandTask = cx.spawn(async () => {
      try {
        while (!this.closed) {
          const command = await herdr.nextCommand();
          if (this.closed) return;
          if (command === 'refresh') await this.refresh();
          else if (command === 'activate-current') await this.activate(this.selectedId);
        }
      } catch { /* Closing an overlay ends its command stream. */ }
    });
  }
  async refreshIdentity() {
    if (this.identityPromise) return this.identityPromise;
    if (this.identityAt !== null && Date.now() - this.identityAt < 15000) return;
    const pending = (async () => {
      try {
        const [core, machines] = await Promise.all([herdr.hc(['server', 'status', '--json']), herdr.hc(['machine', 'ls', '--json'])]);
        if (this.closed) return;
        try { this.coreId = core.code === 0 ? JSON.parse(core.stdout)?.core?.id ?? '' : ''; } catch { this.coreId = ''; }
        try {
          const values = machines.code === 0 ? JSON.parse(machines.stdout)?.machines : [];
          this.machineIds = new Map((Array.isArray(values) ? values : []).filter(item => item.state === 'connected' && typeof item.name === 'string' && typeof item.id === 'string').map(item => [item.name, item.id]));
        } catch { this.machineIds = new Map(); }
      } catch { this.coreId = ''; this.machineIds = new Map(); }
      this.identityAt = Date.now();
    })();
    this.identityPromise = pending;
    try { await pending; } finally { if (this.identityPromise === pending) this.identityPromise = null; }
  }
  async refresh() {
    if (this.closed || !this.reader) return false;
    let success = false;
    try {
      const [snapshot, paneSnapshot] = await Promise.all([this.reader.read(), requestPaneService(this.config, herdr.exec, { op: 'snapshot' }).catch(() => null), this.refreshIdentity()]);
      let paneProblem = null;
      try { if (paneSnapshot) indexPaneNavigation(paneSnapshot); this.paneSnapshot = paneSnapshot; }
      catch { this.paneSnapshot = null; paneProblem = 'Pane service unavailable; run doctor'; }
      if (this.closed) return false;
      this.feeds = snapshot.feeds; this.targetSource = 'feed'; this.problem = paneProblem; success = true;
    } catch { if (!this.closed) { if (this.targetSource === 'pending') this.targetSource = 'native'; this.problem = 'Session information is unavailable'; } }
    if (!this.closed) this.cx.notify();
    return success;
  }
  rows() {
    const spaces = herdr.spaces(), agents = herdr.agents(), terminals = herdr.terminals(), panes = herdr.panes();
    this.spaceIdentities = assignSpaceIdentities(spaces);
    const focus = herdr.focused?.();
    const active = spaces.find(space => space.machine === null && space.id === focus?.space && space.tabs.some(tab => tab.id === focus.tab));
    const destination = active ? { space: active.id, tab: focus.tab } : null;
    const machines = herdr.machines().map(machine => ({ ...machine, ...(this.machineIds.has(machine.name) ? { coreId: this.machineIds.get(machine.name) } : {}) }));
    if (this.targetSource === 'pending') return pickerRows(spaces, [], this.filter).filter(row => row.kind === 'space');
    let targets = this.targetSource === 'feed' ? projectNavigation({ spaces, agents, terminals, panes, feeds: this.feeds, coreId: this.coreId,
      destination, paneSnapshot: this.paneSnapshot, machines, contract: this.config.labelContract, now: Date.now(), completedHours: this.config.retention?.completedHours ?? 24,
      completedRows: this.config.retention?.completedRows ?? 50 }) : nativeTargets(agents, terminals, panes);
    if (this.targetSource === 'feed') {
      const labels = this.config.labelContract.labels, visible = new Set();
      targets = targets.filter(target => {
        if (target.ownerId && !visible.has(target.ownerId)) return false;
        if (target.kind === 'agent') {
          const feedName = this.feeds.some(feed => feed.sessionId === target.sessionId && feed.owner.name && feed.owner.name === target.name);
          const labelName = terminals.some(terminal => (terminal.address === target.terminal || target.sessionId && terminal.labels?.[labels.session] === target.sessionId)
            && terminal.labels?.[labels.displayName] === target.name && typeof target.name === 'string' && target.name.trim());
          const sourceName = this.paneSnapshot?.rows.some(row => row.sessionId === target.sessionId && row.generation === target.generation
            && [row.name, row.target?.name].some(name => typeof name === 'string' && name.trim() && name === target.name));
          if (!feedName && !labelName && !sourceName) return false;
        }
        visible.add(target.id); return true;
      }).map(target => target.sessionId ? target : { ...target, path: null });
    }
    const rows = pickerRows(spaces, targets, this.filter);
    if (!rows.some(row => row.id === this.selectedId && row.enabled)) {
      const current = `tab:${focus?.space}:${focus?.tab}`;
      this.selectedId = this.selectedId === null && rows.some(row => row.id === current && row.enabled) ? current : selectPickerRow(rows, null, 0);
    }
    return rows;
  }
  async activate(id) {
    if (!id || this.closed || this.pending.size) return;
    this.pending.add(id); this.cx.notify();
    try {
      let row = this.rows().find(item => item.id === id && item.enabled);
      if (!row) { if (/^(session|run|console|agent):/.test(id)) this.problem = 'Owning session unavailable'; return; }
      if (row.kind === 'target' && ['ipc', 'pane'].includes(row.target.action?.kind)) {
        if (!this.reader || !await this.refresh() || this.closed) return;
        row = this.rows().find(item => item.id === id && item.enabled);
        if (!row) { this.problem = 'Owning session unavailable'; return; }
      }
      if (this.closed) return;
      if (row.kind === 'space') herdr.run('space.select', { id: row.space });
      else if (row.kind === 'tab') herdr.run('tab.select', { id: row.tab });
      else if (row.kind === 'new-tab') {
        const local = herdr.spaces().find(space => space.id === row.space && space.machine === null);
        if (!local) { this.problem = 'No local space is available'; return; }
        const operationId = Date.now().toString(36) + Math.random().toString(36).slice(2);
        herdr.openOverlay({ mod: 'spider-machine-picker', kind: 'dialog', width: 440, height: 480, frame: 'none', props: { continuation: 'menu', machineKey: null, intent: { operationId, space: local.id, place: 'tab', anchor: null, program: { kind: 'shell' } } } });
      } else if (row.kind === 'new-space') herdr.run('space.new', { machine: '' });
      else if (row.kind === 'target') {
        const action = row.target.action;
        if (!action) return;
        if (action.kind === 'focus') herdr.run('pane.focus', { pane: action.pane });
        else if (action.kind === 'pane') await requestPaneService(this.config, herdr.exec, action.request);
        else {
          const requestId = Date.now().toString(36).padStart(10, '0') + Math.random().toString(36).slice(2).padEnd(13, '0') + Math.random().toString(36).slice(2).padEnd(13, '0');
          const keep = herdr.commands?.().find(command => command.name === 'terminal.keep');
          const request = { ...action.request, requestId, ...(action.request.op === 'openSession' ? {
            ...(this.returnFocus ? { returnFocus: this.returnFocus } : {}),
            backgroundKeep: Boolean(keep?.args?.some(arg => arg.name === 'focus')),
          } : {}) };
          this.opening = { descriptor: action.descriptor, requestId, generation: request.generation };
          const [node, ...args] = panelIpcArgv(this.config.nodePath, this.config.cliPath, action.descriptor, request);
          const result = await herdr.exec(node, args, { timeout: 65000 }), reply = parseSessionIpcReply(result.stdout);
          this.opening = null;
          if (!reply || result.code !== 0 || !reply.ok || reply.op !== action.request.op) {
            throw new Error(describeOpenFailure(reply));
          }
          const terminal = reply.op === 'openSession' ? reply.terminal : reply.op === 'openRun' || reply.op === 'openJob' ? reply.viewer : null;
          if (terminal && !this.closed) herdr.run('pane.focus', { terminal });
        }
      } else return;
      await this.close();
    } catch (error) { if (!this.closed) this.problem = String(error?.message ?? 'Session action failed'); }
    finally { this.opening = null; this.pending.delete(id); if (!this.closed) this.cx.notify(); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.watch?.cancel?.(); this.watch = null; this.watchTask?.cancel?.(); this.commandTask?.cancel?.(); this.timer?.cancel?.();
    if (this.opening) {
      const { descriptor, requestId, generation } = this.opening;
      const [node, ...args] = panelIpcArgv(this.config.nodePath, this.config.cliPath, descriptor, { op: 'cancelOpen', requestId, generation });
      void herdr.exec(node, args, { timeout: 10000 }).catch(() => {});
    }
    await this.reader?.close();
    if (this.overlay) herdr.closeOverlay(this.overlay);
  }
  render() {
    const rows = this.rows(), selected = rows.find(row => row.id === this.selectedId);
    const heights = rows.map(() => 32);
    const tops = []; let total = 0; heights.forEach(height => { tops.push(total); total += height; });
    const height = Math.min(320, this.listHeight ?? 320), maxScroll = Math.max(0, total - height), fixed = total > height;
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const selectedIndex = rows.indexOf(selected);
    const followKey = selectedIndex < 0 ? null : `${selected.id}:${tops[selectedIndex]}:${height}`;
    if (selectedIndex >= 0 && this.followKey !== followKey) {
      if (tops[selectedIndex] < this.scroll) this.scroll = tops[selectedIndex];
      if (tops[selectedIndex] + heights[selectedIndex] > this.scroll + height) this.scroll = tops[selectedIndex] + heights[selectedIndex] - height;
    }
    this.followKey = followKey;
    const mono = this.config?.fonts?.paths ?? 'JetBrains Mono', body = this.config?.fonts?.body ?? 'Google Sans Flex', t = herdr.theme();
    const rowView = (row, index) => {
      const status = row.kind === 'target' ? row.target.status : null;
      const shape = row.kind === 'space' ? svg(`mods/spider-picker/space-${this.spaceIdentities.get(row.space)?.shape ?? 'triangle'}.svg`).size(14).text_color(t.muted)
        : row.kind === 'target' ? svg(row.target.kind === 'subagent' ? 'mods/spider-agents/bot.svg' : 'mods/workspace-chrome/terminal.svg').size(14).text_color(t.muted)
        : div().w(14).text_color(t.muted).child(row.kind === 'new-tab' || row.kind === 'new-space' ? '+' : '');
      const item = h_flex().id(`pk-${row.id}`).mx(4).px(10).pl(10 + (row.kind === 'target' ? row.depth * 16 : 0)).h(32).rounded(7).gap(8).items_center()
        .when(row.id === this.selectedId, element => element.bg(SELECTED))
        .when(row.enabled, element => element.cursor_pointer().hover(style => style.bg(HOVER))
          .on_mouse_move((_event, current) => { this.selectedId = row.id; current.notify(); })
          .on_click(() => { void this.activate(row.id); }))
        .when(row.kind === 'new-tab' && !row.enabled, element => element.tooltip('No local space is available'))
        .when(row.kind === 'target' && !row.enabled && Boolean(row.target.disabledReason), element => element.tooltip(row.target.disabledReason))
        .child(shape).child(div().flex_1().min_w(0).truncate()
          .when(row.kind === 'heading', element => element.font_family(body).text_size(11.5).font_medium().text_color(t.dim))
          .when(row.kind !== 'heading', element => element.font_family(mono).text_size(13).font_normal().text_color(row.enabled ? t.foreground : t.muted))
          .child(row.label));
      if (row.kind === 'target' && row.target.path) item.child(div().max_w(140).truncate().font_family(mono).font_normal().text_size(10).text_color(t.dim).child(row.target.path));
      if (status === 'blocked') item.child(div().font_family(body).text_size(10.5).font_semibold().text_color(t.blocked).child('needs you'));
      if (status === 'error') item.child(div().font_family(mono).font_normal().text_size(10.5).text_color(t.ansi1).child('error'));
      if (row.kind === 'target' && row.target.machine) item.child(div().px(5).rounded(999).bg(FAINT).font_family(body).font_normal().text_color(t.dim).text_size(10).child(row.target.machine));
      return fixed ? item.absolute().left(0).right(0).top(tops[index] - this.scroll).bottom(height - tops[index] - heights[index] + this.scroll) : item;
    };
    return v_flex().id('picker').track_focus(this.handle).w_full().min_h(0).p(18).gap(10).rounded(12).bg(BG).font_family(body).font_normal().text_size(13)
      .on_key_down((event, current) => {
        const key = event.key;
        if (key === 'escape') { void this.close(); current.stop_propagation(); return; }
        if (key === 'down' || key === 'up') this.selectedId = selectPickerRow(rows, this.selectedId, key === 'down' ? 1 : -1);
        else if (key === 'd' && event.modifiers?.control && selected?.kind === 'tab') { herdr.run('tab.close', { id: selected.tab }); void this.close(); }
        else return;
        current.stop_propagation(); current.notify();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child('Go to…'))
        .child(div().id('picker-esc').px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover(style => style.bg(HOVER)).on_click(() => { void this.close(); }).child('Esc')))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).bg(FAINT)
        .child(svg('mods/workspace-chrome/search.svg').size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().font_family(body).font_normal().text_size(13).text_color(t.foreground)))
      .when(Boolean(this.problem), element => element.child(div().text_size(11).text_color(t.ansi1).child(this.problem)))
      .when(this.pending.size > 0, element => element.child(div().text_size(11).text_color(t.dim).child('Opening…')))
      .child(v_flex().id('pk-list').h(Math.min(320, total || 32)).min_h(0).overflow_hidden()
        .on_size_change((size, current) => { this.listHeight = size.height / (herdr.settings().zoom || 1); current.notify(); })
        .when(fixed, element => element.on_scroll_wheel((event, current) => { this.scroll = Math.max(0, Math.min(this.scroll - event.delta.y, maxScroll)); current.notify(); }))
        .children(rows.length ? rows.map((row, index) => !fixed || tops[index] + heights[index] > this.scroll && tops[index] < this.scroll + height ? rowView(row, index) : null).filter(Boolean)
          : [div().px(10).text_color(t.dim).child('No results')]));
  }
}
export default Picker;
