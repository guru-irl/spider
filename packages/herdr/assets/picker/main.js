// SPDX-License-Identifier: Apache-2.0
// Derived from Herdr's picker. See NOTICE for upstream provenance.
import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import * as herdr from 'herdr';
import { pickerRows, selectPickerRow } from './model.js';
import { projectNavigation } from '../shared/navigation.js';
import { assignSpaceIdentities } from '../shared/look.js';
import { FEED_REFRESH_MS, createFeedReader, panelIpcArgv, parseSessionIpcReply } from '../shared/feed.js';

const BG = '#161618f0', SELECTED = '#ffffff14', HOVER = '#ffffff12', FAINT = '#ffffff0d';
const INK = '#eeeeee', MUTED = '#a0a0a4', AMBER = '#f2c063', RED = '#ff6b6b';
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
  return agents.map(agent => {
    const terminal = known.get(agent.address), pane = panes.find(item => item.terminal === agent.address)?.pane ?? agent.pane ?? null;
    return { id: `agent:${agent.address}`, kind: 'agent', ownerId: null, sessionId: null, terminal: agent.address, pane,
      space: agent.space ?? null, tab: agent.tab ?? null, name: terminal?.labels?.['spider.display-name'] || agent.title || agent.program?.name || agent.address,
      path: null, status: agent.status ?? 'idle', machine: agent.address.includes('/') ? agent.address.split('/')[0] : null,
      retained: false, action: pane ? { kind: 'focus', pane } : null };
  });
}

export class Picker extends View {
  init(_props, cx) {
    this.cx = cx; this.handle = cx.focus_handle(); this.closed = false; this.filter = ''; this.selectedId = null; this.scroll = 0;
    this.feeds = []; this.coreId = ''; this.machineIds = new Map(); this.identityAt = null; this.pending = new Set(); this.problem = null;
    const props = herdr.props() ?? {}; this.overlay = props.overlay; this.config = validConfig(props) ? props : null;
    this.input = InputState.new({ placeholder: 'Go to a space, tab, or agent' });
    this.input.on('change', (_event, current) => { this.filter = this.input.value(); this.selectedId = selectPickerRow(this.rows(), null, 0); current.notify(); });
    this.input.on('submit', () => { void this.activate(this.selectedId); });
    if (herdr.checking?.()) { this.ready = Promise.resolve(); return; }
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
          }
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
      const [snapshot] = await Promise.all([this.reader.read(), this.refreshIdentity()]);
      if (this.closed) return false;
      this.feeds = snapshot.feeds; this.problem = null; success = true;
    } catch { if (!this.closed) this.problem = 'Session information is unavailable'; }
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
    const targets = this.config ? projectNavigation({ spaces, agents, terminals, panes, feeds: this.feeds, coreId: this.coreId,
      destination, machines, contract: this.config.labelContract, now: Date.now(), completedHours: this.config.retention?.completedHours ?? 24,
      completedRows: this.config.retention?.completedRows ?? 50 }) : nativeTargets(agents, terminals, panes);
    const rows = pickerRows(spaces, targets, this.filter);
    if (!rows.some(row => row.id === this.selectedId && row.enabled)) this.selectedId = selectPickerRow(rows, null, 0);
    return rows;
  }
  async activate(id) {
    if (!id || this.closed || this.pending.has(id)) return;
    this.pending.add(id); this.cx.notify();
    try {
      let row = this.rows().find(item => item.id === id && item.enabled);
      if (!row) return;
      if (row.kind === 'target' && row.target.action?.kind === 'ipc') {
        if (!this.reader || !await this.refresh() || this.closed) return;
        row = this.rows().find(item => item.id === id && item.enabled);
        if (!row) return;
      }
      if (this.closed) return;
      if (row.kind === 'space') herdr.run('space.select', { id: row.space });
      else if (row.kind === 'tab') herdr.run('tab.select', { id: row.tab });
      else if (row.kind === 'new-tab') {
        const local = herdr.spaces().find(space => space.id === row.space && space.machine === null);
        if (!local) { this.problem = 'No local space is available'; return; }
        herdr.run('tab.new', { space: local.id });
      } else if (row.kind === 'new-space') herdr.run('space.new', { machine: '' });
      else if (row.kind === 'target') {
        const action = row.target.action;
        if (!action) return;
        if (action.kind === 'focus') herdr.run('pane.focus', { pane: action.pane });
        else if (action.kind === 'keep') herdr.run('terminal.keep', { terminal: action.terminal, place: 'tab' });
        else {
          const [node, ...args] = panelIpcArgv(this.config.nodePath, this.config.cliPath, action.descriptor, action.request);
          const result = await herdr.exec(node, args), reply = parseSessionIpcReply(result.stdout);
          if (!reply || result.code !== 0 || !reply.ok || reply.op !== action.request.op) {
            if (reply && !reply.ok && reply.code === 'unknown-op' && action.request.op === 'openSession') throw new Error('Run /reload to enable session reopening');
            throw new Error(reply && !reply.ok ? reply.message : 'Session action failed');
          }
          const terminal = reply.op === 'openSession' ? reply.terminal : reply.op === 'openRun' || reply.op === 'openJob' ? reply.viewer : null;
          if (terminal && !this.closed) herdr.run('pane.focus', { terminal });
        }
      } else return;
      await this.close();
    } catch (error) { if (!this.closed) this.problem = String(error?.message ?? 'Session action failed'); }
    finally { this.pending.delete(id); if (!this.closed) this.cx.notify(); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.watch?.cancel?.(); this.watch = null; this.watchTask?.cancel?.(); this.commandTask?.cancel?.(); this.timer?.cancel?.();
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
    const mono = this.config?.fonts?.paths ?? 'JetBrains Mono', labels = this.config?.fonts?.label ?? 'Google Sans Flex';
    const rowView = (row, index) => {
      const status = row.kind === 'target' ? row.target.status : null;
      const shape = row.kind === 'space' ? svg(`mods/spider-picker/space-${this.spaceIdentities.get(row.space)?.shape ?? 'triangle'}.svg`).size(14).text_color(MUTED)
        : row.kind === 'target' ? svg(row.target.kind === 'subagent' ? 'mods/spider-agents/bot.svg' : 'mods/workspace-chrome/terminal.svg').size(14).text_color(MUTED)
        : div().w(14).text_color(MUTED).child(row.kind === 'new-tab' || row.kind === 'new-space' ? '+' : '');
      const item = h_flex().id(`pk-${row.id}`).mx(4).px(10).pl(10 + (row.kind === 'target' ? row.depth * 16 : 0)).h(32).rounded(7).gap(8).items_center()
        .when(row.id === this.selectedId, element => element.bg(SELECTED))
        .when(row.enabled, element => element.cursor_pointer().hover(style => style.bg(HOVER))
          .on_mouse_move((_event, current) => { this.selectedId = row.id; current.notify(); })
          .on_click(() => { void this.activate(row.id); }))
        .when(row.kind === 'new-tab' && !row.enabled, element => element.tooltip('No local space is available'))
        .when(row.kind === 'target' && !row.enabled && Boolean(row.target.disabledReason), element => element.tooltip(row.target.disabledReason))
        .child(shape).child(div().flex_1().min_w(0).truncate().when(row.kind === 'target', element => element.font_family(mono)).text_color(row.enabled ? INK : MUTED).child(row.label));
      if (row.kind === 'target' && row.target.path) item.child(div().max_w(140).truncate().font_family(mono).text_size(10).text_color(MUTED).child(row.target.path));
      if (status === 'blocked' || status === 'error') item.child(div().text_size(11).text_color(status === 'blocked' ? AMBER : RED).child(status === 'blocked' ? 'needs you' : 'error'));
      if (row.kind === 'target' && row.target.machine) item.child(div().px(5).rounded(999).bg(FAINT).font_family(mono).text_color(MUTED).text_size(11).child(row.target.machine));
      return fixed ? item.absolute().left(0).right(0).top(tops[index] - this.scroll).bottom(height - tops[index] - heights[index] + this.scroll) : item;
    };
    return v_flex().id('picker').track_focus(this.handle).w_full().min_h(0).p(18).gap(10).rounded(12).bg(BG).font_family(labels).text_size(13)
      .on_key_down((event, current) => {
        const key = event.key;
        if (key === 'escape') { void this.close(); current.stop_propagation(); return; }
        if (key === 'down' || key === 'up') this.selectedId = selectPickerRow(rows, this.selectedId, key === 'down' ? 1 : -1);
        else if (key === 'd' && event.modifiers?.control && selected?.kind === 'tab') { herdr.run('tab.close', { id: selected.tab }); void this.close(); }
        else return;
        current.stop_propagation(); current.notify();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(INK).child('Go to…'))
        .child(div().id('picker-esc').px(6).py(2).rounded(5).text_size(11).text_color(MUTED).cursor_pointer().hover(style => style.bg(HOVER)).on_click(() => { void this.close(); }).child('Esc')))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).bg(FAINT)
        .child(svg('mods/workspace-chrome/search.svg').size(15).text_color(MUTED))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(INK)))
      .when(Boolean(this.problem), element => element.child(div().text_size(11).text_color(RED).child(this.problem)))
      .child(v_flex().id('pk-list').h(Math.min(320, total || 32)).min_h(0).overflow_hidden()
        .on_size_change((size, current) => { this.listHeight = size.height / (herdr.settings().zoom || 1); current.notify(); })
        .when(fixed, element => element.on_scroll_wheel((event, current) => { this.scroll = Math.max(0, Math.min(this.scroll - event.delta.y, maxScroll)); current.notify(); }))
        .children(rows.length ? rows.map((row, index) => !fixed || tops[index] + heights[index] > this.scroll && tops[index] < this.scroll + height ? rowView(row, index) : null).filter(Boolean)
          : [div().px(10).text_color(MUTED).child('No results')]));
  }
}
export default Picker;
