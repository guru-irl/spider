// SPDX-License-Identifier: Apache-2.0
// Menu choices and shortcut labels are adapted from Herdr 0.1.12.
// Modified for spider. See ../look/NOTICE.
import { div, svg, image } from "gpui-kit";
import { Popup, InputState, Input, h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, keys, knownAgents, window } from "herdr";

function activeTab() {
  const space = spaces().find(space => space.active);
  return `${space?.id ?? ""}/${space?.tabs?.find(tab => tab.active)?.id ?? ""}`;
}

function shortcut(name) {
  const binding = keys().find(binding => binding.section === "global" && binding.action === name);
  if (!binding?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return binding.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(modifier => alias[modifier.toLowerCase()] ?? modifier.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(modifier => held.has(modifier)).map(modifier => names[modifier]), label].join(mac ? "" : "+");
  }).join(" ");
}

const SLIDE = 140;
const EDGE = "#38383a";
// The bar rests a few pixels below the strip and starts slightly higher, so the motion is a short drop.
const REST = 4, START = -2, INSET = 8;

export function initTabAutoHide(view, cx) {
  const state = view.tabAuto = { visible: false, slid: false, leaving: false, slideTimer: null, strip: false, row: false, width: 0, active: activeTab(), flashUntil: 0, menu: null, rename: null, plus: false, agents: [], handle: cx.focus_handle() };
  const cancel = () => { state.timer?.cancel(); state.timer = null; };
  const held = () => state.strip || state.row || view.pressed !== null || state.menu || state.rename || state.plus;
  // Leaving slides the bar up behind the strip first, and only then removes it.
  const hide = (delay = 300) => {
    cancel();
    if (held()) return;
    state.timer = cx.timer.after(Math.max(delay, state.flashUntil - Date.now()), cx => {
      state.timer = null;
      if (held()) return;
      state.slid = false; state.leaving = true;
      cx.notify();
      state.timer = cx.timer.after(SLIDE, cx => {
        state.timer = null; state.leaving = false;
        if (!held()) state.visible = false;
        cx.notify();
      });
    });
  };
  const show = cx => { cancel(); state.visible = true; state.leaving = false; state.slideIn(); cx.notify(); };
  // A transition animates only later changes, so the bar is drawn once above the clip and moved down a frame later.
  state.slideIn = () => {
    if (state.slid || state.leaving || state.slideTimer) return;
    state.slideTimer = cx.timer.after(16, cx => {
      state.slideTimer = null;
      if (!state.visible || state.leaving) return;
      state.slid = true;
      cx.notify();
    });
  };
  const rememberFocus = () => { state.focus = focused(); };
  const dismiss = cx => {
    state.menu = null; state.rename = null; state.plus = false;
    if (state.focus?.pane) run("pane.focus", { pane: state.focus.pane });
    else if (state.focus?.terminal) run("pane.focus", { terminal: state.focus.terminal });
    state.focus = null;
    hide(); cx.notify();
  };
  const outside = (kind, cx) => { if (state[kind]) dismiss(cx); };
  const stop = (_event, cx) => cx.stop_propagation();
  const row = (id, icon, name, action, hint = "", enabled = true) => {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_mouse_down("left", stop).on_click((_event, cx) => { if (enabled) action(cx); })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  };
  const activate = (action, cx) => { dismiss(cx); action(); };
  state.renameTab = (tab, cx) => {
    cancel(); rememberFocus(); state.menu = null; state.plus = false;
    view.pressed = null;
    const input = InputState.new({ value: tab.name });
    state.rename = { tab, input, text: tab.name };
    input.set_selected_range({ start: 0, end: tab.name.length });
    input.on("change", (_event, cx) => { if (state.rename) state.rename.text = input.value(); cx.notify(); });
    input.on("submit", (_event, cx) => state.save(cx));
    input.focus(); cx.notify();
  };
  state.save = cx => {
    const rename = state.rename;
    if (!rename) return;
    dismiss(cx);
    run("tab.rename", { id: rename.tab.id, name: rename.text });
  };
  const renameMenu = () => {
    const t = theme();
    return v_flex().id("tabs-rename").w(280).p(10).gap(8).rounded(10).bg(t.popover)
      .on_mouse_down("left", stop).on_mouse_down_out((_event, cx) => outside("rename", cx))
      .on_key_down((event, cx) => { if (event.key === "escape") { cx.stop_propagation(); dismiss(cx); } })
      .child(Input.new(state.rename.input).h(32).px(8).rounded(6).bg(t.input).text_color(t.foreground))
      .child(h_flex().justify_end().gap(6)
        .child(row("tabs-rename-cancel", div(), "Cancel", cx => dismiss(cx)))
        .child(row("tabs-rename-save", div(), "Save", cx => state.save(cx))));
  };
  const contextMenu = () => {
    const t = theme(), { tab, space } = state.menu;
    const choices = [
      ["Rename", cx => state.renameTab(tab, cx)],
      ["New tab", cx => activate(() => run("tab.new", { space: space.id }), cx)],
      ["Close", cx => activate(() => run("tab.close", { id: tab.id }), cx)],
    ];
    return v_flex().id("tabs-context-menu").w(200).p(5).rounded(10).bg(t.popover).text_size(12.8)
      .track_focus(state.handle).on_mouse_down("left", stop).on_mouse_down_out((_event, cx) => outside("menu", cx))
      .on_key_down((event, cx) => {
        if (event.key === "escape") dismiss(cx);
        else if (event.key === "up" || event.key === "down") { state.selected = (state.selected + (event.key === "down" ? 1 : choices.length - 1)) % choices.length; cx.notify(); }
        else if (event.key === "enter") choices[state.selected][1](cx);
        else return;
        cx.stop_propagation();
      })
      .children(choices.map(([label, action], index) => row(`tabs-action-${index}`, div(), label, action).bg(index === state.selected ? t.selected : t.chrome)));
  };
  const newMenu = () => {
    const t = theme(), space = spaces().find(space => space.active);
    const installed = state.agents.filter(agent => agent.installed);
    const choices = [...installed, ...state.agents.filter(agent => !agent.installed).slice(0, 2)];
    return v_flex().id("tabs-new-menu").w(250).h(Math.min(491, 167 + Math.max(1, choices.length) * 31)).min_h(0).bg(t.popover).rounded(10).p(5).text_size(12.8)
      .track_focus(state.handle).on_mouse_down("left", stop).on_mouse_down_out((_event, cx) => outside("plus", cx))
      .on_key_down((event, cx) => {
        if (event.key === "escape") { dismiss(cx); cx.stop_propagation(); return; }
        if (event.modifiers.control || event.modifiers.platform || event.modifiers.alt) return;
        const agent = /^[1-9]$/.test(event.key) ? installed[Number(event.key) - 1] : null;
        if (agent) { activate(() => run("tab.new", { name: agent.name, space: space?.id, argv: agent.run }), cx); cx.stop_propagation(); }
      })
      .child(row("tabs-new-terminal", svg("icons/shell.svg").size(14), "Terminal", cx => activate(() => run("tab.new", { space: space?.id }), cx), shortcut("tab.new")))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((agent, index) => row(`tabs-agent-${agent.key}`, agent.tint ? svg(agent.icon).size(14).text_color(t.foreground) : image(agent.icon).size(14), agent.name,
          cx => activate(() => run("tab.new", { name: agent.name, space: space?.id, argv: agent.run }), cx), agent.installed ? (index < 9 ? String(index + 1) : "") : "not installed", agent.installed)))
        .when(!state.agents.length, el => el.child(div().px(9).py(6).text_color(t.dim).child(state.failed ? "Could not load agents" : "Checking installed agents..."))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(row("tabs-new-space", div().w(14).child("+"), "New space", cx => activate(() => run("space.new"), cx), shortcut("space.new")))
      .child(row("tabs-new-worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree...", cx => activate(() => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find(pane => pane.focused)?.cwd, action: "new" } }), cx), "", Boolean(space)))
      .child(row("tabs-open-worktree", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree...", cx => activate(() => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(pane => pane.focused)?.cwd, action: "open" } }), cx), "", Boolean(space)));
  };
  state.context = (tab, space, cx) => { cancel(); rememberFocus(); state.rename = null; state.plus = false; state.menu = { tab, space }; state.selected = 0; state.handle.focus(); cx.notify(); };
  state.newMenu = cx => {
    if (state.plus) { dismiss(cx); return; }
    cancel(); rememberFocus(); state.menu = null; state.rename = null; state.plus = true; state.failed = false; state.agents = [];
    const space = spaces().find(space => space.active), request = state.request = {};
    state.handle.focus(); cx.notify();
    cx.spawn(async cx => {
      try { const agents = await knownAgents({ on: space?.machine }); if (state.plus && state.request === request) state.agents = agents; }
      catch { if (state.plus && state.request === request) state.failed = true; }
      if (state.plus && state.request === request) cx.notify();
    });
  };
  state.wrapTab = (tab, pill) => Popup.new(`tabs-item-${tab.id}`, pill).anchor("top_left")
    .when(state.menu?.tab.id === tab.id, el => el.content(contextMenu()))
    .when(state.rename?.tab.id === tab.id, el => el.content(renameMenu()));
  state.wrapNew = button => Popup.new("tabs-new-popup", button).anchor("top_right").when(state.plus, el => el.content(newMenu()));
  state.hover = (area, hovered, cx) => { state[area] = hovered; if (hovered) show(cx); else hide(); };
  state.hold = () => { cancel(); cx.notify(); };
  state.release = () => { hide(); cx.notify(); };
  state.hide = hide;
}

export function renderTabAutoHide(view, row, cx) {
  const state = view.tabAuto, active = activeTab();
  if (state.active !== active) {
    state.active = active;
    if (state.pointerTab !== active) { state.visible = true; state.flashUntil = Date.now() + 1500; state.hide(0); }
    state.pointerTab = null;
  }
  const strip = div().id("tabs-strip").w_full().h(6).bg(theme().chrome)
    .on_hover((hovered, cx) => state.hover("strip", hovered, cx))
    .on_size_change((size, cx) => { if (state.width !== size.width) { state.width = size.width; cx.notify(); } });
  if (state.visible) state.slideIn();
  // Popup keeps eight pixels clear at the window edge; the bar takes the same margin on the left.
  const width = Math.max(0, state.width - 8);
  const motion = { duration: SLIDE, easing: "ease-out" };
  const bar = row.id("tabs-revealed").absolute().left(INSET).top(state.slid ? REST : START).h(42).w(Math.max(0, width - INSET)).bg(theme().popover)
    .border_1().border_color(EDGE).rounded(10)
    .transition("top", motion)
    .on_hover((hovered, cx) => state.hover("row", hovered, cx));
  // A fade carries most of the motion, which stays smooth at any frame rate.
  let content = div().id("tabs-slide").relative().w(width).h(42 + REST).opacity(state.slid ? 1 : 0).transition("opacity", motion).child(bar);
  if (view.pressed !== null) {
    const viewport = globalThis.window.viewport_size();
    // The transparent capture covers the window from any tab's position.
    const capture = div().id("tabs-drag-capture").absolute().left(-viewport.width).top(-viewport.height).w(viewport.width * 3).h(viewport.height * 3)
      .on_mouse_up("left", (_event, cx) => { cx.stop_propagation(); view.pressed = null; state.release(); });
    content = div().relative().w(width).h(42 + REST).child(capture).child(content);
  }
  return Popup.new("tabs-popup", strip).size_full().anchor("top_left")
    .when(state.visible, el => el.content(content));
}

export function closeTabAutoHide(view) {
  view.tabAuto?.timer?.cancel();
  view.tabAuto?.slideTimer?.cancel();
}
