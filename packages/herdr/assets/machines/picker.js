// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { View, div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import * as herdr from 'herdr';
import { capturePaneIntent, issueMenuTicket, selectMachine } from './actions.js';

const BG = '#161618f0', SELECTED = '#ffffff14', HOVER = '#ffffff12', FAINT = '#ffffff0d';
const INK = '#eeeeee', MUTED = '#a0a0a4', AMBER = '#f2c063', RED = '#ff6b6b';
const absolute = value => typeof value === 'string' && (/^\//.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) && !value.includes('\0');
const operationId = () => Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

export function machinePickerView(defaultPlace) {
  return class MachinePicker extends View {
    init(_props, cx) {
      this.cx = cx; this.handle = cx.focus_handle(); this.closed = false; this.pending = false;
      this.filter = ''; this.selectedKey = null; this.machines = []; this.problem = null; this.loading = true; this.scroll = 0;
      const props = herdr.props() ?? {}; this.overlay = props.overlay; this.continuation = props.continuation;
      const focus = herdr.focused?.();
      const space = herdr.spaces().find(item => item.machine === null && item.id === focus?.space)
        ?? herdr.spaces().find(item => item.machine === null && item.active);
      const tab = space?.tabs.find(item => item.id === focus?.tab) ?? space?.tabs.find(item => item.active);
      const modelPane = focus?.pane && tab && herdr.panes().find(item => item.pane === focus.pane && item.tab === tab.id);
      this.placement = modelPane && space ? { space: space.id, tab: tab.id, pane: modelPane.pane } : null;
      this.focusTerminal = focus?.terminal ?? null;
      this.space = space?.id ?? null;
      this.intent = props.intent ? { ...props.intent, anchor: props.intent.anchor ? { ...props.intent.anchor } : null, program: { ...props.intent.program } } : null;
      const explicitAnchor = this.intent?.anchor;
      const anchorPane = explicitAnchor ? herdr.panes().find(item => item.pane === explicitAnchor.pane && item.tab === explicitAnchor.tab) : modelPane;
      this.anchorFound = Boolean(anchorPane);
      this.anchorTerminal = anchorPane?.terminal ?? null;
      this.defaultKey = props.machineKey ?? null;
      this.input = InputState.new({ placeholder: 'Filter machines' });
      this.input.on('change', (_event, current) => { this.filter = this.input.value(); this.selectedKey = selectMachine(this.rows(), this.filter, this.selectedKey); current.notify(); });
      this.input.on('submit', () => { void this.activate(this.selectedKey); });
      if (herdr.checking?.()) { this.loading = false; this.ready = Promise.resolve(); return; }
      this.input.focus();
      this.ready = new Promise(resolve => cx.spawn(async current => {
        try {
          const mod = props.intent || defaultPlace === 'tab' ? 'spider-machine-picker' : `spider-machine-picker-${defaultPlace}`;
          const content = await herdr.readTextFile(`${herdr.appHome()}/mods/${mod}/config.json`);
          const config = content ? JSON.parse(content) : null;
          if (!config || config.version !== 1 || !absolute(config.nodePath) || !absolute(config.cliPath)) throw new Error('Machine picker is not configured');
          this.config = config;
          if (config.checkMode || this.closed) return;
          const snapshot = await this.snapshot();
          if (this.closed) return;
          this.machines = snapshot.machines;
          const focused = this.focusTerminal ? snapshot.presentations.find(item => item.visibility === 'visible' && (item.proxy === this.focusTerminal ||
            (item.mode === 'native' && item.target.address === this.focusTerminal))) ?? null : null;
          const target = focused?.target ?? null;
          const preferred = target ? this.machines.find(row => row.coreId === target.coreId)?.key : this.machines.find(row => row.alias === null)?.key;
          this.selectedKey = selectMachine(this.rows(), '', this.defaultKey ?? preferred ?? null);
          if (!this.intent && this.space) this.intent = capturePaneIntent({ operationId: operationId(), space: this.space, focused, nativeTarget: null,
            focusedPlacement: this.placement, machines: this.machines }, defaultPlace);
          this.timer = current.timer?.every(5000, next => { if (!this.closed && !this.pending) next.spawn(async () => this.refresh()); });
        } catch { if (!this.closed) this.problem = 'Machine information is unavailable'; }
        finally { this.loading = false; resolve(); current.notify(); }
      }));
    }
    async snapshot() {
      const request = { version: 1, op: 'snapshot', operationId: operationId() };
      const result = await herdr.exec(this.config.nodePath, [this.config.cliPath, 'panes', 'request', '--json', JSON.stringify(request)], { timeout: 5000 });
      if (result.code !== 0) throw new Error('Machine information is unavailable');
      const reply = JSON.parse(result.stdout);
      if (reply?.version !== 1 || reply.kind !== 'snapshot' || !Array.isArray(reply.machines) || !Array.isArray(reply.presentations)) throw new Error('Invalid machine information');
      this.omittedRows = Number.isSafeInteger(reply.omittedRows) && reply.omittedRows > 0 ? reply.omittedRows : 0;
      return reply;
    }
    async refresh() {
      try {
        const snapshot = await this.snapshot();
        if (this.closed) return;
        this.machines = snapshot.machines; this.problem = null;
        this.selectedKey = selectMachine(this.rows(), this.filter, this.selectedKey);
      } catch { if (!this.closed) this.problem = 'Machine information is unavailable'; }
      if (!this.closed) this.cx.notify();
    }
    rows() {
      return this.machines.filter(row => `${row.alias ?? 'This computer'} ${row.label}`.toLocaleLowerCase().includes(this.filter.trim().toLocaleLowerCase()))
        .map(row => {
          const state = row.state !== 'connected' || !row.coreId ? 'Unreachable' : 'Connected';
          return { ...row, label: row.alias === null ? 'This computer' : row.alias, enabled: state === 'Connected', stateText: state };
        });
    }
    validDestination() {
      const anchor = this.intent.anchor;
      const space = herdr.spaces().find(item => item.machine === null && item.id === this.intent.space);
      if (!space || (anchor && (anchor.space !== space.id || !space.tabs.some(tab => tab.id === anchor.tab)))) return false;
      return this.intent.place === 'tab' || Boolean(anchor && this.anchorFound && herdr.panes().some(pane =>
        pane.pane === anchor.pane && pane.tab === anchor.tab && pane.terminal === this.anchorTerminal));
    }
    async activate(key) {
      if (!key || this.closed || this.pending || !this.config || this.config.checkMode || !this.intent) return;
      const choice = this.rows().find(row => row.key === key && row.enabled);
      if (!choice) return;
      this.pending = true; this.cx.notify();
      try {
        if (!this.validDestination()) { this.problem = 'The original pane is unavailable'; return; }
        const snapshot = await this.snapshot();
        if (this.closed) return;
        const current = snapshot.machines.find(row => row.key === choice.key);
        if (!current || current.state !== 'connected' || current.coreId !== choice.coreId || current.machineId !== choice.machineId) {
          this.machines = snapshot.machines; this.problem = 'Machine is unreachable'; return;
        }
        if (!this.validDestination()) { this.problem = 'The original pane is unavailable'; return; }
        if (this.continuation === 'menu') {
          const machineTicket = issueMenuTicket(this.intent, current, herdr);
          await this.close();
          herdr.openOverlay({ mod: 'spider-new-menu', kind: 'popup', width: 250, height: 512, props: { machineTicket } });
          return;
        }
        const request = { version: 1, op: 'open', operationId: this.intent.operationId, intent: this.intent, machineKey: key, coreId: current.coreId, machineId: current.machineId };
        const result = await herdr.exec(this.config.nodePath, [this.config.cliPath, 'panes', 'request', '--json', JSON.stringify(request)], { timeout: 5000 });
        const reply = result.code === 0 ? JSON.parse(result.stdout) : null;
        if (reply?.version !== 1 || reply.kind !== 'outcome' || reply.outcome?.status === 'refused') throw new Error(reply?.outcome?.reason || 'Could not open terminal');
        if (!this.closed) await this.close();
      } catch (error) { if (!this.closed) this.problem = String(error?.message ?? 'Could not open terminal'); }
      finally { this.pending = false; if (!this.closed) this.cx.notify(); }
    }
    async close() {
      if (this.closed) return;
      this.closed = true; this.timer?.cancel?.();
      if (this.overlay) herdr.closeOverlay(this.overlay);
    }
    render() {
      const rows = this.rows();
      const available = rows.filter(row => row.enabled);
      if (!available.some(row => row.key === this.selectedKey)) this.selectedKey = selectMachine(rows, this.filter, this.selectedKey);
      const total = rows.length * 32, height = Math.min(320, this.listHeight ?? 320), maxScroll = Math.max(0, total - height);
      this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
      const selectedIndex = rows.findIndex(row => row.key === this.selectedKey);
      const followKey = selectedIndex < 0 ? null : `${this.selectedKey}:${selectedIndex}:${height}`;
      if (selectedIndex >= 0 && this.followKey !== followKey) {
        if (selectedIndex * 32 < this.scroll) this.scroll = selectedIndex * 32;
        if ((selectedIndex + 1) * 32 > this.scroll + height) this.scroll = (selectedIndex + 1) * 32 - height;
      }
      this.followKey = followKey;
      const labels = this.config?.fonts?.label ?? 'Google Sans Flex', mono = this.config?.fonts?.paths ?? 'JetBrains Mono';
      return v_flex().id('machine-picker').track_focus(this.handle).w_full().p(18).gap(10).rounded(12).bg(BG).font_family(labels).text_size(13)
        .on_key_down((event, current) => {
          if (event.key === 'escape') { void this.close(); current.stop_propagation(); return; }
          if ((event.key === 'down' || event.key === 'up') && available.length) {
            const index = available.findIndex(row => row.key === this.selectedKey), delta = event.key === 'down' ? 1 : -1;
            this.selectedKey = available[(index + delta + available.length) % available.length].key;
            current.stop_propagation(); current.notify();
          }
        })
        .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(INK).child('Choose machine'))
          .child(div().id('machine-esc').px(6).py(2).rounded(5).text_size(11).text_color(MUTED).cursor_pointer().hover(style => style.bg(HOVER)).on_click(() => { void this.close(); }).child('Esc')))
        .child(h_flex().h(36).px(10).rounded(9).bg(FAINT).items_center().child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(INK)))
        .when(Boolean(this.problem), element => element.child(div().text_size(11).text_color(RED).child(this.problem)))
        .when(this.omittedRows > 0, element => element.child(div().text_size(11).text_color(MUTED).child(`${this.omittedRows} more`)))
        .when(this.pending, element => element.child(div().text_size(11).text_color(MUTED).child('Opening…')))
        .child(v_flex().id('machine-list').h(Math.min(320, total || 32)).min_h(0).overflow_hidden()
          .on_size_change((size, current) => { this.listHeight = size.height / (herdr.settings().zoom || 1); current.notify(); })
          .when(total > height, element => element.on_scroll_wheel((event, current) => { this.scroll = Math.max(0, Math.min(this.scroll - event.delta.y, maxScroll)); current.notify(); }))
          .children(rows.map((row, index) => {
            if (total > height && (index * 32 + 32 <= this.scroll || index * 32 >= this.scroll + height)) return null;
            const item = h_flex().id(`machine-${row.key}`).mx(4).px(10).h(32).rounded(7).gap(8).items_center()
              .when(row.key === this.selectedKey && row.enabled, element => element.bg(SELECTED))
              .when(row.enabled, element => element.cursor_pointer().hover(style => style.bg(HOVER))
                .on_mouse_move((_event, current) => { this.selectedKey = row.key; current.notify(); })
                .on_click(() => { void this.activate(row.key); }))
              .child(div().flex_1().min_w(0).truncate().font_family(mono).text_color(row.enabled ? INK : MUTED).child(row.label))
              .child(div().text_size(11).text_color(row.stateText === 'Unreachable' ? AMBER : MUTED).child(row.stateText));
            return total > height ? item.absolute().left(0).right(0).top(index * 32 - this.scroll).bottom(height - index * 32 - 32 + this.scroll) : item;
          }).filter(Boolean))
          .when(this.loading, element => element.child(div().px(10).text_color(MUTED).child('Loading')))
          .when(!available.length && !this.pending && !this.loading, element => element.child(div().px(10).text_color(MUTED).child('No available machines match'))));
    }
  };
}
