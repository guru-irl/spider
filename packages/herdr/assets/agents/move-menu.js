// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, theme, spaces, panes, terminals, focused, run, exec, hc, readTextFile, openOverlay, closeOverlay, notify } from 'herdr';
import { panelIpcArgv, parseSessionIpcReply, FEED_DISCONNECT_MS } from './shared/feed.js';
import { classifyPane, menuItems, moveTarget, killTarget, stopSessionTarget, moveTerminal, journalOwnsTerminal } from './move.js';

export function initMoveMenu(view, cx) {
  view.moveAt = 0;
  view.moveTabs = false;
  view.moveConfirm = null;
  view.moveHandle = cx.focus_handle();
  view.moveHandle.focus();
  view.spiderFeeds = [];
  const initial = props() ?? {};
  view.moveLoading = initial.moveMenu?.kind === 'pane' || Boolean(initial.feedRoot);
  view.moveUnmanaged = false;
  if (view.moveLoading) cx.spawn(async cx => {
    try { await view.reloadSpiderFeeds(); } catch { /* Missing feeds leave owner actions unavailable. */ }
    const p = props() ?? {};
    if (p.feedRoot && p.moveMenu?.kind === 'pane') try { view.moveUnmanaged = !journalOwnsTerminal(await readTextFile(p.feedRoot + '/spaces/spaces.json'), p.moveMenu.terminal); } catch { /* An unreadable journal cannot prove that the terminal is unmanaged. */ }
    view.moveLoading = false; cx.notify();
  });
}

function targetFor(view) {
  const p = props() ?? {}, source = p.moveMenu ?? {};
  if (source.kind === 'subagent') {
    const matches = (view.spiderFeeds ?? []).filter(feed => feed.runs?.rows?.some(row => row.id === source.key && row.ownerSessionId === feed.sessionId));
    const feed = matches.length === 1 ? matches[0] : null;
    const descriptor = feed?.lifecycle === 'live' && feed.ipc && Date.now() - feed.updatedAt <= FEED_DISCONNECT_MS
      ? { version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc }
      : !p.feedRoot && source.action?.kind === 'ipc' ? source.action.descriptor : null;
    const run = feed?.runs?.rows?.find(row => row.id === source.key);
    const active = run ? !['done', 'failed', 'cancelled'].includes(run.status) : !source.retained;
    return { kind: 'subagent', key: source.key, terminal: source.terminal, descriptor,
      pane: panes().some(pane => pane.terminal === source.terminal && source.terminal),
      active: active && Boolean(descriptor), machine: source.terminal?.includes('/') ? source.terminal.split('/')[0] : null };
  }
  const pane = panes().find(value => value.pane === source.pane && value.terminal === source.terminal);
  if (!pane) return null;
  const target = classifyPane(pane, terminals().find(value => value.address === pane.terminal), view.spiderFeeds ?? [], p.labelContract, Date.now() - FEED_DISCONNECT_MS);
  if (target.kind === 'session' && !target.descriptor && view.moveUnmanaged) target.unmanaged = true;
  return target;
}

async function callOwner(descriptor, request) {
  const p = props() ?? {};
  if (!p.nodePath || !p.cliPath) throw new Error('Session actions are unavailable');
  const argv = panelIpcArgv(p.nodePath, p.cliPath, descriptor, request);
  const result = await exec(argv[0], argv.slice(1));
  const reply = parseSessionIpcReply(result.stdout.trim());
  if (result.code !== 0 || !reply?.ok) throw new Error(reply?.message ?? 'Session action failed');
}

async function movePlain(terminal, destination, cx) {
  const p = props() ?? {};
  const current = () => {
    const pane = panes().find(value => value.terminal === terminal);
    if (!pane) return null;
    const space = spaces().find(value => value.tabs.some(tab => tab.id === pane.tab));
    return space ? { space: space.id, tab: pane.tab, pane: pane.pane } : null;
  };
  const source = current();
  if (!source) throw new Error('The terminal pane is unavailable');
  const targetSpace = destination.kind === 'tab' ? spaces().find(space => space.tabs.some(tab => tab.id === destination.tab))?.id : source.space;
  if (!targetSpace) throw new Error('The target tab is unavailable');
  const machine = terminal.includes('/') ? terminal.split('/')[0] : null;
  const targetMachine = targetSpace.includes('/') ? targetSpace.split('/')[0] : null;
  if (machine !== targetMachine) throw new Error('A terminal cannot move to another machine');
  const local = value => machine && value.startsWith(machine + '/') ? value.slice(machine.length + 1) : value;
  await moveTerminal(terminal, { ...destination, space: targetSpace }, {
    now: Date.now, timeoutMs: 20000, sleep: ms => cx.sleep(ms),
    placement: async () => current(), targetPane: async () => null,
    tabExists: async tab => spaces().some(space => space.tabs.some(value => value.id === tab)),
    run: (name, args) => run(name, args),
    createTab: async space => {
      if (!p.appBinary) throw new Error('The app executable is unavailable');
      const result = await exec(p.appBinary, ['do', 'tab.new', '--space', space, '--mod', 'pane']);
      if (result.code !== 0) throw new Error('The new tab could not be created');
      const reply = JSON.parse(result.stdout);
      if (!reply.tab || !reply.pane) throw new Error('The new tab has no pane');
      return { space: reply.space ?? space, tab: reply.tab, pane: reply.pane };
    },
    adopt: async (address, placement) => {
      const result = await hc(['label', address, `herdr.space=${local(placement.space)}`, `herdr.tab=${local(placement.tab)}`, '--json']);
      if (result.code !== 0) throw new Error('The terminal could not be placed');
    },
    changed: async () => {},
  });
}

function actionsFor(target, view) {
  const p = props() ?? {}, pane = panes().find(value => value.terminal === target.terminal);
  const items = menuItems(target, spaces(), focused()?.space ?? null, pane?.tab ?? null);
  if (!view.moveTabs) return items.map(item => item.kind === 'tabs' && !item.groups.length ? { ...item, disabled: true } : item);
  const groups = items.find(item => item.kind === 'tabs')?.groups ?? [];
  return [{ kind: 'action', id: 'back', label: 'Back' }, ...groups.flatMap(group => [
    { kind: 'heading', label: group.name }, ...group.tabs.map(tab => ({ kind: 'action', id: `tab-${tab.id}`, label: tab.name, tab: tab.id })),
  ])];
}

function choose(view, target, item, cx) {
  if (!item || item.disabled || item.kind === 'heading' || item.kind === 'separator') return;
  if (item.kind === 'tabs') { view.moveTabs = true; view.moveAt = 0; cx.notify(); return; }
  if (item.id === 'back') { view.moveTabs = false; view.moveAt = 0; cx.notify(); return; }
  return cx.spawn(async cx => {
    try {
      if (item.id === 'kill') await killTarget(target, { ipc: callOwner, run, confirm: spec => { view.moveConfirm = { ...spec, pending: false }; cx.notify(); } });
      else {
        const destination = item.id === 'hide' ? { kind: 'hide' } : item.tab ? { kind: 'tab', tab: item.tab } : { kind: 'new' };
        await moveTarget(target, destination, { ipc: callOwner, movePlain: (terminal, dest) => movePlain(terminal, dest, cx) });
      }
      if (!view.moveConfirm) closeOverlay(props().overlay);
    } catch (error) {
      notify({ title: item.id === 'kill' ? 'Kill failed' : 'Move failed', body: error instanceof Error ? error.message : 'The action could not be completed.', level: 'error' });
    }
  });
}

function renderKillConfirmation(view, cx) {
  const t = theme(), prompt = view.moveConfirm;
  const cancel = () => { if (!prompt.pending) closeOverlay(props().overlay); };
  const confirm = () => {
    if (prompt.pending) return;
    prompt.pending = true; cx.notify();
    return cx.spawn(async cx => {
      try { await stopSessionTarget(prompt.target, { ipc: callOwner }); closeOverlay(props().overlay); }
      catch (error) {
        prompt.pending = false; cx.notify();
        notify({ title: 'Kill failed', body: error instanceof Error ? error.message : 'The session could not be stopped.', level: 'error' });
      }
    });
  };
  const button = (id, label, action) => div().id(id).px(10).py(7).rounded(6).text_color(t.foreground)
    .when(prompt.pending, el => el.disabled(true)).when(!prompt.pending, el => el.hover(s => s.bg(t.hover)).cursor_pointer().on_click(action)).child(label);
  return v_flex().id('move-kill-prompt').track_focus(view.moveHandle).w_full().p(14).gap(12).bg(t.popover).text_color(t.foreground)
    .on_key_down(event => { if (event.key === 'escape') cancel(); else if (event.key === 'enter') confirm(); })
    .child(div().font_medium().child(prompt.title)).child(div().text_size(12.8).text_color(t.muted).child(prompt.detail))
    .child(h_flex().gap(6).justify_end().child(button('move-kill-cancel', 'Cancel', cancel))
      .child(button('move-kill-confirm', prompt.pending ? 'Stopping…' : 'Kill session', confirm)));
}

const ROW_HEIGHT = 31, SEPARATOR_HEIGHT = 9, HEADING_HEIGHT = 29, SEPARATOR_MARGIN = 4;

// Popups size to their content, and a scroll container has no height of its own, so give the list one.
function listHeight(items) {
  return items.reduce((sum, item) => sum + (item.kind === 'separator' ? SEPARATOR_HEIGHT : item.kind === 'heading' ? HEADING_HEIGHT : ROW_HEIGHT), 0);
}

export function renderMoveMenu(view, cx) {
  const t = theme();
  if (view.moveConfirm) return renderKillConfirmation(view, cx);
  if (view.moveLoading) return v_flex().p(12).bg(t.popover).text_size(12.8).text_color(t.muted).child('Loading session');
  const target = targetFor(view);
  if (!target) return v_flex().p(12).bg(t.popover).text_size(12.8).text_color(t.muted).child('Pane unavailable');
  const items = actionsFor(target, view), selectable = items.filter(item => item.kind !== 'separator' && item.kind !== 'heading' && !item.disabled);
  if (view.moveAt >= selectable.length) view.moveAt = 0;
  const root = v_flex().id('move-menu').track_focus(view.moveHandle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
    .on_key_down((event, cx) => {
      if (event.key === 'down' && selectable.length) view.moveAt = (view.moveAt + 1) % selectable.length;
      else if (event.key === 'up' && selectable.length) view.moveAt = (view.moveAt + selectable.length - 1) % selectable.length;
      else if (event.key === 'enter') choose(view, target, selectable[view.moveAt], cx);
      else if (event.key === 'escape' && view.moveTabs) { view.moveTabs = false; view.moveAt = 0; }
      else if (event.key === 'escape') closeOverlay(props().overlay);
      else return;
      cx.notify();
    });
  const height = listHeight(items), list = v_flex().id('move-menu-items').flex_none().h(Math.min(380, height));
  const scroll = height > 380 ? list.overflow_y_scrollbar().mode('always') : list.overflow_y_scrollbar();
  return root.child(scroll.children(items.map(item => {
    if (item.kind === 'separator') return div().mx(7).my(SEPARATOR_MARGIN).h(SEPARATOR_HEIGHT - 2 * SEPARATOR_MARGIN).flex_none().bg(t.border);
    if (item.kind === 'heading') return div().h(HEADING_HEIGHT).flex_none().px(8).pb(3).flex().items_end().text_size(11).font_medium().text_color(t.muted).child(item.label);
    const index = selectable.indexOf(item);
    return h_flex().id(`move-${item.id}`).h(ROW_HEIGHT).flex_none().px(8).rounded(7).items_center().text_color(item.disabled ? t.dim : t.foreground)
      .when(Boolean(item.disabled), el => el.disabled(true))
      .when(index >= 0 && index === view.moveAt, el => el.bg(t.selected))
      .when(!item.disabled, el => el.hover(s => s.bg(t.hover)).cursor_pointer().on_click((_event, cx) => choose(view, target, item, cx)))
      .child(div().flex_1().truncate().child(item.label));
  }))).when(target.kind !== 'terminal' && !target.descriptor && !target.unmanaged,
    el => el.child(div().px(8).pt(6).pb(4).text_size(11).text_color(t.muted).child('Owner unavailable')));
}
